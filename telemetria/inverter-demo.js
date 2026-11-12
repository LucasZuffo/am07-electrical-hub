function createInverterDemo(clock = () => performance.now() / 1000) {
  const tau = 2 * Math.PI;
  const polePairs = 4;
  const flux = 0.006067;
  const torquePerAmp = 1.5 * polePairs * flux;
  const maxRpm = 5500;
  const teknicPeakIq = 7.1;
  const names = [
    "Id", "Iq", "theta_elec", "omega_elec", "Vd", "Vq", "Iu", "Iv", "Iw",
    "res_sin", "res_cos", "res_w_lpf", "vbus", "theta_est", "theta_err",
  ];
  const states = { IDLE: 0, ALIGN_ROTOR: 2, RUN: 3, FAULT: 4 };
  const writable = [
    ["control_mode", 0x0032, "u16", "", "0 = torque; 1 = velocidade.", 1, 0, 1],
    ["omega_ref", 0x0003, "f32", "rad/s elét.", "Referência no modo velocidade. Use o comando rápido para ajustar em RPM.", 1200 * tau * polePairs / 60, -maxRpm * tau * polePairs / 60, maxRpm * tau * polePairs / 60],
    ["iq_ref", 0x0002, "f32", "A", "Referência de corrente de torque no modo torque.", 3, -12, 12],
    ["id_ref", 0x0001, "f32", "A", "Referência de corrente do eixo direto no modelo simulado.", 0, -12, 12],
    ["iq_max", 0x0050, "f32", "A", "Limite de corrente de torque no modelo simulado.", 8, 0, 12],
    ["vmax_frac", 0x0051, "f32", "fração", "Limita a tensão disponível para o modelo.", 0.85, 0, 1],
    ["vbus_ovr", 0x0043, "f32", "V", "Tensão usada no cálculo do modelo. Zero usa o barramento simulado.", 0, 0, 60],
    ["kp_d", 0x0010, "f32", "V/A", "Ganho proporcional do eixo direto. Edite com o motor em IDLE.", 0.35, 0, 5, true],
    ["ki_d", 0x0011, "f32", "", "Ganho integral do eixo direto. Edite com o motor em IDLE.", 0.025, 0, 1, true],
    ["kp_q", 0x0012, "f32", "V/A", "Ganho proporcional do eixo de torque. Edite com o motor em IDLE.", 0.35, 0, 5, true],
    ["ki_q", 0x0013, "f32", "", "Ganho integral do eixo de torque. Edite com o motor em IDLE.", 0.025, 0, 1, true],
    ["kp_w", 0x0020, "f32", "A/(rad/s elét.)", "Ganho proporcional da malha de velocidade simulada. Edite em IDLE.", 0.024, 0, 1, true],
    ["ki_w", 0x0021, "f32", "", "Ganho integral da malha de velocidade simulada. Edite em IDLE.", 0.01, 0, 1, true],
  ];
  const readOnly = [
    ["state", 0x0100, "u16", "", "Estado do motor simulado."],
    ["pole_pairs", 0x0103, "u16", "", "Pares de polos do motor representado."],
    ["omega_meas", 0x0104, "f32", "rad/s elét.", "Velocidade elétrica medida no modelo."],
    ["fault_code", 0x0107, "u16", "", "Máscara de falhas simuladas."],
    ["warn_code", 0x0134, "u16", "", "Máscara de avisos simulados."],
    ["vmag", 0x0106, "f32", "V", "Magnitude da tensão no modelo."],
    ["flux_vs", 0x0113, "f32", "V·s", "Fluxo do motor representado."],
    ["vbus", 0x0115, "f32", "V", "Tensão de barramento simulada."],
  ];
  const params = Object.fromEntries(writable.map(([name, , , , , value]) => [name, value]));
  const parameters = [
    ...writable.map(([name, id, type, unit, description, , , , needsIdle = false]) =>
      ({ name, id, type, unit, description, needsIdle, readOnly: false })),
    ...readOnly.map(([name, id, type, unit, description]) =>
      ({ name, id, type, unit, description, readOnly: true, needsIdle: false })),
  ];

  const limit = (value, min, max) => Math.max(min, Math.min(max, value));
  const follow = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));
  const wrap = (value) => ((value % tau) + tau) % tau;
  let motorState = "RUN";
  let fault = 0;
  let load = 25;
  let aligningUntil = 0;
  let afterAlignment = "IDLE";
  let rpm = 1200;
  let id = 0;
  let iq = 0.0005 * rpm + load * 0.05;
  let theta = 0;
  let speedIntegral = 0;
  let now = clock();
  const history = [];

  function point(time) {
    const vbus = 48 - Math.abs(iq) * 0.32;
    const maximumVoltage = (params.vbus_ovr || vbus) * params.vmax_frac / Math.sqrt(3);
    const omega = rpm * tau * polePairs / 60;
    const vd = limit(id * 0.38, -maximumVoltage, maximumVoltage);
    const vqLimit = Math.sqrt(Math.max(0, maximumVoltage ** 2 - vd ** 2));
    const vq = limit(flux * omega + iq * 0.38, -vqLimit, vqLimit);
    return { time, rpm, id, iq, theta, vbus, vd, vq, omega };
  }

  function integrate(time) {
    const dt = time - now;
    const running = motorState === "RUN";
    const speedControl = running && params.control_mode === 1;
    const rpmError = params.omega_ref * 60 / (tau * polePairs) - rpm;
    const drag = 0.0005 * rpm;
    const loadCurrent = Math.sign(rpm) * load * 0.05;
    if (speedControl) {
      speedIntegral = limit(speedIntegral + rpmError * params.ki_w * dt, -params.iq_max, params.iq_max);
    } else {
      speedIntegral = 0;
    }
    const voltageFraction = limit((params.vbus_ovr || 48) / 48 * params.vmax_frac / 0.85, 0, 1);
    const currentLimit = params.iq_max * voltageFraction;
    const targetIq = speedControl ? rpmError * params.kp_w + speedIntegral + drag + loadCurrent : params.iq_ref;
    const targetId = running ? params.id_ref : motorState === "ALIGN_ROTOR" ? 1.3 : 0;
    const rateD = 4 + 18 * params.kp_d + 30 * params.ki_d;
    const rateQ = 4 + 18 * params.kp_q + 30 * params.ki_q;
    id = follow(id, targetId, rateD, dt);
    iq = follow(iq, running ? limit(targetIq, -currentLimit, currentLimit) : 0, rateQ, dt);
    const previousRpm = rpm;
    rpm = running
      ? limit(rpm + 330 * (iq - drag - loadCurrent) * dt, -maxRpm, maxRpm)
      : follow(rpm, 0, 4, dt);
    theta += ((previousRpm + rpm) / 2) * tau * polePairs / 60 * dt;
    now = time;
    if (motorState === "ALIGN_ROTOR" && time >= aligningUntil) motorState = afterAlignment;
    history.push(point(time));
  }

  // Prime a steady window so the first capture is complete.
  const initialOmega = rpm * tau * polePairs / 60;
  for (let index = 1300; index >= 0; index -= 1) {
    const secondsAgo = index / 100;
    history.push({ ...point(now - secondsAgo), theta: -initialOmega * secondsAgo });
  }

  function advance() {
    const time = Math.max(now, clock());
    const start = Math.max(now, time - 13);
    if (start > now) {
      now = start;
      history.length = 0;
      history.push(point(now));
    }
    while (time - now > 0.01) integrate(now + 0.01);
    if (time > now) integrate(time);
    const first = history.findIndex((sample) => sample.time >= time - 13);
    if (first > 1) history.splice(0, first - 1);
  }

  function snapshot() {
    const sample = history.at(-1);
    const torque = torquePerAmp * sample.iq;
    return {
      state: motorState, rpm: sample.rpm, vbus: sample.vbus, torque,
      power: torque * sample.rpm * tau / 60000, id: sample.id, iq: sample.iq,
      fault, warning: 0, faultReason: fault ? "Sobrecorrente simulada" : "",
      references: {
        mode: params.control_mode, rpm: Math.round(params.omega_ref * 60 / (tau * polePairs)),
        torque: Number((params.iq_ref * torquePerAmp).toFixed(3)), currentLimit: params.iq_max, load,
      },
    };
  }

  function read(name) {
    const sample = history.at(-1);
    const measurements = {
      state: states[motorState], pole_pairs: polePairs, omega_meas: sample.omega, fault_code: fault,
      warn_code: 0, vmag: Math.hypot(sample.vd, sample.vq), flux_vs: flux, vbus: sample.vbus,
    };
    if (Object.hasOwn(params, name)) return { name, value: params[name] };
    if (Object.hasOwn(measurements, name)) return { name, value: measurements[name] };
    throw new Error("Parâmetro ausente no catálogo simulado.");
  }

  function write(name, value) {
    const definition = writable.find(([candidate]) => candidate === name);
    if (!definition) throw new Error("Este parâmetro é somente leitura.");
    const [, , type, , , , min, max, needsIdle] = definition;
    if (needsIdle && motorState !== "IDLE") throw new Error("Pare o motor para editar este parâmetro.");
    if (!Number.isFinite(value) || (type === "u16" && !Number.isInteger(value))) {
      throw new Error("Informe um valor numérico compatível com o parâmetro.");
    }
    params[name] = limit(value, min, max);
    return read(name);
  }

  function capture(channels, decimation) {
    const n_samples = 128;
    const selected = names.filter((name) => channels.includes(name));
    const data = selected.map(() => []);
    let cursor = 0;
    for (let index = 0; index < n_samples; index += 1) {
      const time = now - (n_samples - index - 1) * decimation / 10000;
      while (cursor + 1 < history.length - 1 && history[cursor + 1].time < time) cursor += 1;
      const a = history[cursor];
      const b = history[cursor + 1] ?? a;
      const fraction = b.time === a.time ? 0 : limit((time - a.time) / (b.time - a.time), 0, 1);
      const mix = (key) => a[key] + (b[key] - a[key]) * fraction;
      const angle = mix("theta");
      const ripple = 0.012 * Math.sin(tau * 900 * time);
      const d = mix("id") + ripple;
      const q = mix("iq") - ripple;
      const phase = (shift) => d * Math.cos(angle + shift) - q * Math.sin(angle + shift);
      const angleError = 0.025 * Math.sin(angle);
      const values = {
        Id: d, Iq: q, theta_elec: wrap(angle), omega_elec: mix("omega"), Vd: mix("vd"), Vq: mix("vq"),
        Iu: phase(0), Iv: phase(-tau / 3), Iw: phase(tau / 3), res_sin: 2048 + 1300 * Math.sin(angle / polePairs),
        res_cos: 2048 + 1300 * Math.cos(angle / polePairs), res_w_lpf: mix("omega") * 0.995,
        vbus: mix("vbus") + ripple, theta_est: wrap(angle + angleError), theta_err: angleError,
      };
      selected.forEach((name, channel) => data[channel].push(time < a.time ? null : values[name]));
    }
    return { names: selected, n_channels: selected.length, n_samples, data };
  }

  function command(action) {
    if (action === "stop" && !fault) motorState = "IDLE";
    if (action === "inject_fault") {
      fault = 1;
      motorState = "FAULT";
    }
    if (action === "clear_fault" && fault) {
      fault = 0;
      motorState = "IDLE";
    }
    if ((action === "align" || action === "run") && motorState === "IDLE") {
      afterAlignment = action === "run" ? "RUN" : "IDLE";
      motorState = "ALIGN_ROTOR";
      aligningUntil = now + 0.75;
    }
    return snapshot();
  }

  return {
    setPedal(percent) {
      advance();
      const iqReference = limit(percent, 0, 100) / 100 * teknicPeakIq;
      write("control_mode", 0);
      write("iq_ref", iqReference);
      return { iqReference, snapshot: snapshot() };
    },
    request(op, fields = {}) {
      advance();
      switch (op) {
        case "connect": return { port: "SIMULADOR", parameters, channels: names, snapshot: snapshot() };
        case "poll": return snapshot();
        case "read": return read(fields.name);
        case "write": return { ...write(fields.name, fields.value), references: snapshot().references };
        case "scope": return capture(fields.channels, fields.decimation);
        case "command": return command(fields.action);
        case "references":
          if (![0, 1].includes(fields.mode) || ![fields.currentLimit, fields.load, fields.mode ? fields.rpm : fields.torque].every(Number.isFinite)) {
            throw new Error("Revise os valores das referências.");
          }
          write("control_mode", fields.mode);
          if (fields.mode === 1) write("omega_ref", fields.rpm * tau * polePairs / 60);
          else write("iq_ref", fields.torque / torquePerAmp);
          write("iq_max", fields.currentLimit);
          load = limit(fields.load, 0, 100);
          return snapshot();
        default: throw new Error("Operação indisponível no simulador.");
      }
    },
  };
}
