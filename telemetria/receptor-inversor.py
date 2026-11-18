"""Serve the Hub using the Inverter Manager's serial client."""

import argparse
import json
import math
import sys
import threading
import time
import webbrowser
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


SITE_ROOT = Path(__file__).resolve().parents[1]
ADDRESS = "127.0.0.1"
PORT = 8791
HOST = f"{ADDRESS}:{PORT}"
ORIGIN = f"http://{HOST}"
API_PATH = "/api/inversor"
LIVE_PAGE = f"{ORIGIN}/telemetria/#inversor-usb"
STATIC_DIRS = {"telemetria", "estilos", "imagens", "design", "ferramentas", "inventario"}
STATIC_TYPES = {".html", ".css", ".js", ".svg", ".png", ".jpeg", ".jpg", ".webp", ".ico"}
IDLE_TIMEOUT = 30
SCOPE_SAMPLES = 128
DEFAULT_ISR_HZ = 10_000
VOLTAGE_LIMIT_PARAM = "vmax_frac"
TORQUE_READINGS = ("control_mode", "iq_ref", "iq_max", "pos_status", "obs_iq_max")
FW_READINGS = ("fw_en", "fw_id", "vmag", "fw_vmax_frac")
SNAPSHOT_PARAMS = (
    "fault_code", "warn_code", "vbus", "omega_meas", "pole_pairs", *TORQUE_READINGS, *FW_READINGS,
)
MOTOR_COMMANDS = {
    "run": "request_run",
    "align": "request_align",
    "stop": "request_stop",
    "clear_fault": "clear_fault",
}


def finite_value(value):
    return value if math.isfinite(value) else None


def observer_active(position_status):
    return None if position_status is None else bool(int(position_status) & 1)  # POS_STATUS_OBS_ACTIVE


class Inverter:
    def __init__(self, api, serial_link, proto):
        self.api = api
        self.serial_link = serial_link
        self.proto = proto
        self.scope_names = [name for _, name in proto.SCOPE_CATALOG]
        self.lock = threading.Lock()
        self.owner = None
        self.link = self.device = None
        self.parameters = {}
        self.last_request = 0
        self.scope_config = None
        self.scope_ready_at = 0
        self.scope_isr_hz = DEFAULT_ISR_HZ
        self.voltage_fraction_ceiling = None
        self.torque_per_amp = None
        self.motor_peak_amps = None

    def close(self):
        if self.link is not None:
            self.link.close()
        self.owner = self.link = self.device = None
        self.parameters.clear()
        self.scope_config = None
        self.scope_ready_at = 0
        self.scope_isr_hz = DEFAULT_ISR_HZ
        self.voltage_fraction_ceiling = None
        self.torque_per_amp = None
        self.motor_peak_amps = None

    def expire(self):
        if self.lock.acquire(blocking=False):
            try:
                if self.owner and time.monotonic() - self.last_request > IDLE_TIMEOUT:
                    self.close()
            finally:
                self.lock.release()

    def read_value(self, name):
        return finite_value(self.device.read_param(name))

    def read_available(self, names):
        return {name: self.read_value(name) for name in names if name in self.parameters}

    def control_bus(self, measured_bus):
        override = self.read_value("vbus_ovr") if "vbus_ovr" in self.parameters else None
        uses_override = override is not None and override > 0
        return override if uses_override else measured_bus, uses_override

    def voltage_limit(self, bus, uses_override):
        if self.voltage_fraction_ceiling is None:
            return None
        fraction = self.read_value(VOLTAGE_LIMIT_PARAM)
        if bus is None or bus <= 0 or fraction is None or not 0 <= fraction <= 1:
            return None
        half_bus = bus / 2
        return {
            "volts": fraction * half_bus,
            "maxVolts": self.voltage_fraction_ceiling * half_bus,
            "halfBus": half_bus,
            "usesOverride": uses_override,
            "needsIdle": self.parameters[VOLTAGE_LIMIT_PARAM].needs_idle,
        }

    def set_voltage_limit(self, volts):
        if type(volts) not in (float, int) or not 0 <= volts < math.inf:
            raise ValueError("Informe um limite de tensão válido.")
        if self.voltage_fraction_ceiling is None:
            raise ValueError("Este firmware não oferece ajuste do limite de tensão.")
        state = self.device.state_name(self.device.sm_state())
        allowed = ("IDLE",) if self.parameters[VOLTAGE_LIMIT_PARAM].needs_idle else ("IDLE", "RUN")
        if state not in allowed or ("fault_code" in self.parameters and self.read_value("fault_code") != 0):
            raise ValueError("Ajuste o limite em IDLE ou RUN, sem falha ativa e conforme permitido pelo firmware.")
        limit = self.voltage_limit(*self.control_bus(self.read_value("vbus")))
        if limit is None or volts > limit["maxVolts"] + 1e-8:
            raise ValueError("Confira o barramento e ajuste a tensão dentro da faixa mostrada na bancada.")
        fraction = min(volts / limit["halfBus"], self.voltage_fraction_ceiling)
        if self.device.write_param(VOLTAGE_LIMIT_PARAM, fraction) != self.proto.PARAM_WR_OK:
            raise RuntimeError("A MCU recusou o ajuste do limite de tensão.")
        confirmed = self.voltage_limit(*self.control_bus(self.read_value("vbus")))
        if confirmed is None:
            raise RuntimeError("Não foi possível confirmar o limite na MCU. Confira a leitura antes de tentar novamente.")
        return confirmed

    def torque_reference(self, values):
        mode, iq_ref, iq_limit = (values.get(name) for name in ("control_mode", "iq_ref", "iq_max"))
        if mode not in (0, 1) or iq_ref is None or iq_limit is None or iq_limit < 0 or self.torque_per_amp is None:
            return None
        if self.motor_peak_amps is not None:
            iq_limit = min(iq_limit, self.motor_peak_amps)
        observer_limit = values.get("obs_iq_max")
        if observer_active(values.get("pos_status")) and observer_limit is not None and observer_limit >= 0:
            iq_limit = min(iq_limit, observer_limit)
        iq_param = self.parameters["iq_ref"]
        mode_param = self.parameters["control_mode"]
        return {
            "mode": int(mode), "nm": iq_ref * self.torque_per_amp, "iq": iq_ref,
            "maxNm": iq_limit * self.torque_per_amp, "maxIq": iq_limit,
            "canWrite": iq_param.type == self.proto.PARAM_TYPE_F32 and not iq_param.read_only and not iq_param.needs_idle,
            "canSelectMode": mode_param.type == self.proto.PARAM_TYPE_U16 and not mode_param.read_only,
            "modeNeedsIdle": mode_param.needs_idle,
        }

    def select_torque_mode(self):
        control = self.torque_reference(self.read_available(TORQUE_READINGS))
        if control is None or not control["canSelectMode"]:
            raise ValueError("Este firmware não oferece seleção de modo torque.")
        state = self.device.state_name(self.device.sm_state())
        allowed = ("IDLE",) if control["modeNeedsIdle"] else ("IDLE", "RUN")
        if state not in allowed or ("fault_code" in self.parameters and self.read_value("fault_code") != 0):
            raise ValueError("O estado atual da MCU não permite mudar o modo de controle.")
        if control["mode"] != 0 and self.device.write_param("control_mode", 0) != self.proto.PARAM_WR_OK:
            raise RuntimeError("A MCU recusou a seleção do modo torque.")
        confirmed = self.torque_reference(self.read_available(TORQUE_READINGS))
        if confirmed is None or confirmed["mode"] != 0:
            raise RuntimeError("A MCU não confirmou o modo torque.")
        return confirmed

    def set_torque_reference(self, nm):
        if type(nm) not in (int, float) or not -math.inf < nm < math.inf:
            raise ValueError("Informe uma referência de torque válida em Nm.")
        control = self.torque_reference(self.read_available(TORQUE_READINGS))
        if control is None or not control["canWrite"] or control["mode"] != 0:
            raise ValueError("Selecione o modo torque na MCU antes de aplicar uma referência.")
        if abs(nm) > control["maxNm"] + 1e-9:
            raise ValueError("A referência excede a faixa de torque permitida pela MCU.")
        state = self.device.state_name(self.device.sm_state())
        if state != "RUN" or ("fault_code" in self.parameters and self.read_value("fault_code") != 0):
            raise ValueError("Aplique torque com a MCU em RUN sem falha ativa.")
        iq = max(-control["maxIq"], min(control["maxIq"], nm / self.torque_per_amp))
        if self.device.write_param("iq_ref", iq) != self.proto.PARAM_WR_OK:
            raise RuntimeError("A MCU recusou a referência de torque.")
        confirmed = self.torque_reference(self.read_available(TORQUE_READINGS))
        if confirmed is None or confirmed["mode"] != 0 or not math.isclose(confirmed["iq"], iq, abs_tol=1e-6, rel_tol=1e-6):
            raise RuntimeError("A leitura da MCU não confirmou a corrente solicitada. Confira o estado do inversor.")
        return confirmed

    def field_weakening(self, values, state, control_bus):
        enabled, fw_id, requested, fraction = (values.get(name) for name in FW_READINGS)
        if all(value is None for value in (enabled, fw_id, requested, fraction)):
            return None
        return {
            "enabled": None if enabled is None else bool(enabled),
            "observerActive": observer_active(values.get("pos_status")),
            "idAmps": fw_id if state == "RUN" else None,
            "requestedVolts": requested if state == "RUN" else None,
            "targetVolts": fraction * control_bus / 2 if fraction is not None and control_bus and control_bus > 0 else None,
        }

    def snapshot(self):
        state = self.device.state_name(self.device.sm_state())
        values = self.read_available(SNAPSHOT_PARAMS)
        bus, uses_override = self.control_bus(values.get("vbus"))
        fault, warning = values.get("fault_code"), values.get("warn_code")
        omega, pole_pairs = values.get("omega_meas"), values.get("pole_pairs")
        rpm = omega * 60 / (2 * math.pi * pole_pairs) if omega is not None and pole_pairs else None
        return {
            "state": state, "fault": fault, "warning": warning, "vbus": values.get("vbus"), "rpm": rpm,
            "faultReason": self.api.fault_reason(fault) if fault else "",
            "warningReason": self.api.warn_reason(warning) if warning else "",
            "voltageLimit": self.voltage_limit(bus, uses_override),
            "torqueReference": self.torque_reference(values),
            "fieldWeakening": self.field_weakening(values, state, bus),
        }

    def connect(self, owner, port):
        if self.owner and self.owner != owner:
            raise ValueError("O inversor está conectado em outra aba do Hub. Desconecte-o lá e tente novamente.")
        if not isinstance(port, str) or port not in {item.device for item in self.serial_link.debug_ports()}:
            raise ValueError("Porta serial indisponível. Atualize a lista de portas.")
        self.close()
        try:
            self.link = self.serial_link.SerialLink(port=port, timeout=1.0)
        except OSError as error:
            raise ValueError(
                f"Não foi possível abrir {port}. Desconecte a porta no Gerenciador do Inversor "
                "ou em outro programa que esteja usando a serial."
            ) from error
        try:
            self.device = self.api.FocDebug(self.link)
            self.parameters = {item.name: item for item in self.device.list_params()}
            motor = self.read_available(("pole_pairs", "flux_vs", "i_peak_a"))
            pole_pairs, flux, peak_amps = (motor.get(name) for name in ("pole_pairs", "flux_vs", "i_peak_a"))
            if pole_pairs and pole_pairs > 0 and flux and flux > 0:
                self.torque_per_amp = 1.5 * pole_pairs * flux
            if peak_amps is not None and peak_amps > 0:
                self.motor_peak_amps = peak_amps
            voltage_param = self.parameters.get(VOLTAGE_LIMIT_PARAM)
            if (voltage_param and voltage_param.type == self.proto.PARAM_TYPE_F32
                    and not voltage_param.read_only and "vbus" in self.parameters):
                initial_fraction = self.read_value(VOLTAGE_LIMIT_PARAM)
                if initial_fraction is not None and 0 <= initial_fraction <= 1:
                    self.voltage_fraction_ceiling = initial_fraction
            if "isr_freq_hz" in self.parameters:
                isr_hz = self.read_value("isr_freq_hz")
                if isr_hz and isr_hz > 0:
                    self.scope_isr_hz = isr_hz
            reading = self.snapshot()
        except Exception:
            self.close()
            raise
        self.owner = owner
        return {
            "port": self.link.port, "channels": self.scope_names, "snapshot": reading,
            "commands": list(MOTOR_COMMANDS),
            "parameters": [
                {"name": item.name, "type": item.type_str, "readOnly": True}
                for item in self.parameters.values()
            ],
        }

    def command(self, action):
        if not isinstance(action, str) or action not in MOTOR_COMMANDS:
            raise ValueError("Comando de bancada inválido.")
        if action != "stop":
            state = self.device.state_name(self.device.sm_state())
            if action == "clear_fault":
                if state != "FAULT":
                    raise ValueError("A MCU precisa indicar FAULT para limpar a falha.")
            elif state != "IDLE" or ("fault_code" in self.parameters and self.read_value("fault_code") != 0):
                raise ValueError("Para rodar ou calibrar, a MCU precisa estar em IDLE, sem falha ativa.")
        state = getattr(self.device, MOTOR_COMMANDS[action])()
        if state not in self.api.STATE_NAMES:
            raise RuntimeError("A MCU não confirmou o comando. Confira o estado antes de tentar novamente.")
        return {"state": self.device.state_name(state)}

    def capture(self, channels, decimation):
        if not isinstance(channels, list) or not channels or any(name not in self.scope_names for name in channels):
            raise ValueError("Selecione sinais do osciloscópio da MCU.")
        if type(decimation) is not int or not 1 <= decimation <= 65535:
            raise ValueError("A decimação deve ser um inteiro entre 1 e 65535.")
        mask = self.proto.names_to_mask(channels)
        sample_ms = 1_000 * decimation / self.scope_isr_hz
        if self.scope_config != (mask, decimation):
            previous = self.scope_config
            self.scope_config = None
            if self.device.scope_config(decim=decimation, mask=mask) != 0:
                raise RuntimeError("A MCU recusou a configuração do osciloscópio.")
            self.scope_config = (mask, decimation)
            if previous is None or previous[1] != decimation:
                # The ring still contains samples from before the new decimation.
                self.scope_ready_at = time.monotonic() + SCOPE_SAMPLES * sample_ms / 1_000
        remaining_ms = math.ceil(1_000 * (self.scope_ready_at - time.monotonic()))
        if remaining_ms > 0:
            return {"waitMs": remaining_ms}
        frame = self.device.capture_scope(timeout=1.5, retries=1)
        if frame.mask != mask:
            self.scope_config = None
            raise RuntimeError("A captura veio com sinais diferentes dos selecionados. Tente novamente.")
        return {
            "names": frame.names, "n_samples": frame.n_samples, "sample_ms": sample_ms,
            "data": [[finite_value(value) for value in signal] for signal in frame.data],
        }

    def request(self, data):
        op = data.get("op")
        with self.lock:
            if op == "ports":
                return {
                    "ports": [
                        {"port": item.device, "description": item.description}
                        for item in self.serial_link.debug_ports()
                    ],
                    "preferred": self.serial_link.autodetect_port(),
                }
            owner = data.get("session")
            if not isinstance(owner, str) or not 1 <= len(owner) <= 64:
                raise ValueError("Sessão da telemetria inválida.")
            if op == "disconnect":
                if owner == self.owner:
                    self.close()
                return {}
            if op == "connect":
                result = self.connect(owner, data.get("port"))
                self.last_request = time.monotonic()
                return result
            if owner != self.owner:
                raise ValueError("Porta desconectada. Clique em Conectar MCU.")
            try:
                if op == "poll":
                    return self.snapshot()
                if op == "read":
                    name = data.get("name")
                    if not isinstance(name, str) or name not in self.parameters:
                        raise ValueError("Parâmetro indisponível no firmware.")
                    return {"name": name, "value": self.read_value(name)}
                if op == "scope":
                    return self.capture(data.get("channels"), data.get("decimation"))
                if op == "command":
                    return self.command(data.get("action"))
                if op == "voltage_limit":
                    return self.set_voltage_limit(data.get("volts"))
                if op == "torque_mode":
                    return self.select_torque_mode()
                if op == "torque_reference":
                    return self.set_torque_reference(data.get("nm"))
                raise ValueError("Operação indisponível no receptor do inversor.")
            finally:
                self.last_request = time.monotonic()


class Server(ThreadingHTTPServer):
    def __init__(self, handler, inverter):
        super().__init__((ADDRESS, PORT), handler)
        self.inverter = inverter

    def service_actions(self):
        self.inverter.expire()


class Handler(SimpleHTTPRequestHandler):
    def send_head(self):
        if self.headers.get("Host") != HOST:
            self.send_error(HTTPStatus.FORBIDDEN)
            return None
        target = Path(self.translate_path(self.path))
        if target.is_dir():
            target /= "index.html"
        try:
            relative = target.resolve().relative_to(SITE_ROOT)
        except ValueError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        allowed = relative == Path("index.html") or relative.parts and relative.parts[0] in STATIC_DIRS
        if not allowed or relative.suffix not in STATIC_TYPES or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        return super().send_head()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != API_PATH:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if self.headers.get("Host") != HOST or self.headers.get("Origin") != ORIGIN:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 1024 or self.headers.get_content_type() != "application/json":
                raise ValueError
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError
        except ValueError:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Solicitação de telemetria inválida."})
            return
        inverter = self.server.inverter
        try:
            result = inverter.request(data)
        except (ValueError, KeyError, OSError, RuntimeError, inverter.serial_link.LinkError) as error:
            self.send_json(HTTPStatus.CONFLICT, {"error": str(error)})
            return
        self.send_json(HTTPStatus.OK, result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("foc_host", type=Path, help="Pasta host do FOC, que contém foc_debug")
    parser.add_argument("--open", action="store_true", help="Abrir o Hub no navegador")
    args = parser.parse_args()
    if not (args.foc_host / "foc_debug" / "link.py").is_file():
        parser.error("A pasta indicada não contém foc_debug/link.py.")
    sys.path.insert(0, str(args.foc_host.resolve()))
    try:
        from foc_debug import api, link, proto
    except ImportError as error:
        parser.error(f"Use o Python do Gerenciador do Inversor. {error}")

    inverter = Inverter(api, link, proto)
    handler = partial(Handler, directory=SITE_ROOT)
    try:
        with Server(handler, inverter) as server:
            print(f"Telemetria do inversor: {LIVE_PAGE}", flush=True)
            if args.open:
                webbrowser.open(LIVE_PAGE)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    except OSError as error:
        parser.exit(1, f"Não foi possível iniciar o receptor local em {HOST}. {error}\n")
    finally:
        with inverter.lock:
            inverter.close()


if __name__ == "__main__":
    main()
