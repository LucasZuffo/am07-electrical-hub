const pageNames = {
  overview: "Visão geral",
  suspension: "Suspensão",
  tires: "Pneus",
  dynamics: "Dinâmica",
  chassis: "Deformação mecânica do chassis",
  brakes: "Pressão da linha de freio",
  bearing: "Vibração do mancal",
  development: "Monitoramento do chicote",
  database: "Banco de dados do carro"
};
const dashboardTitle = document.title;

const telemetryProtocol = JSON.parse(
  document.getElementById("telemetryProtocol").textContent
);

window.ufprFormulaTelemetryEvProtocol = telemetryProtocol;
document.documentElement.dataset.protocolVersion = telemetryProtocol.version;

const state = {
  running: true,
  source: "simulation",
  connectionState: "simulation",
  expectedTransport: "simulation",
  backendUrl: "ws://127.0.0.1:8787/ws",
  inverterUrl: "ws://127.0.0.1:8787/ws",
  backendMode: null,
  lastPacketAt: null,
  reconnectAttempts: 0,
  manuallyDisconnected: false,
  elapsed: 12 * 60 + 48,
  speed: 128,
  rpm: 6420,
  torque: 184,
  power: 62,
  sequence: 12034
};

const sourceDefinitions = {
  simulation: {
    label: "Simulação local",
    note: "A simulação funciona sem hardware e mantém os valores demonstrativos da interface.",
    footer: "Dados simulados atualizando a cada 500 ms"
  },
  usb_serial: {
    label: "USB serial direto",
    note: "Inicie o receptor local em modo serial na porta COM do ESP32. O painel recebe os pacotes pelo WebSocket local.",
    footer: "Aguardando telemetria do USB serial"
  },
  usb_rf: {
    label: "Receptor USB por RF",
    note: "Inicie o receptor local na porta COM do módulo USB-RF. CRC, sequência, RSSI e perda são tratados antes de atualizar o painel.",
    footer: "Aguardando telemetria do receptor USB-RF"
  },
  mqtt: {
    label: "MQTT em nuvem",
    note: "Inicie o receptor local em modo MQTT. Ele assina o broker com TLS, valida e registra os pacotes e os encaminha ao painel.",
    footer: "Aguardando telemetria MQTT da nuvem"
  },
  inverter: {
    label: "Inversor F28379D (USB)",
    note: "Inicie o receptor do inversor, cole a chave da sessão e selecione a porta COM em Dinâmica.",
    footer: "Aguardando telemetria do inversor"
  },
  inverter_demo: {
    label: "Inversor F28379D (simulação)",
    note: "Abra a bancada virtual com motor, parâmetros editáveis e osciloscópio. Funciona direto no navegador.",
    footer: "Bancada virtual do inversor · dados simulados"
  }
};

const wireDefinitions = [
  {
    key: "aps1", channel: "ADC-01", name: "Pedal do acelerador — APPS 1", side: "left",
    typeLabel: "Analógico proporcional", idealLabel: "0,70–4,20 V", base: 1.82, swing: 0.18,
    min: 0.70, max: 4.20, decimals: 2, simulationState: "ok", color: "var(--accent)",
    source: "Sensor APPS 1 • pedal", destination: "ADC1_CH0 • P1.01", impedance: "12,4 kΩ",
    description: "Canal primário de posição do pedal do acelerador. Deve manter correlação com o APPS 2."
  },
  {
    key: "aps2", channel: "ADC-02", name: "Pedal do acelerador — APPS 2", side: "left",
    typeLabel: "Analógico redundante", idealLabel: "0,35–2,10 V", base: 0.91, swing: 0.09,
    min: 0.35, max: 2.10, decimals: 2, simulationState: "ok", color: "var(--blue)",
    source: "Sensor APPS 2 • pedal", destination: "ADC1_CH1 • P1.02", impedance: "12,8 kΩ",
    description: "Canal redundante do acelerador usado para plausibilidade e detecção de falhas no comando de torque."
  },
  {
    key: "brake-pressure", channel: "ADC-03", name: "Pressão de freio — BPS", side: "left",
    typeLabel: "Analógico proporcional", idealLabel: "0,50–4,50 V", base: 1.34, swing: 0.12,
    min: 0.50, max: 4.50, decimals: 2, simulationState: "ok", color: "var(--orange)",
    source: "Transdutor da linha de freio", destination: "ADC1_CH2 • P1.03", impedance: "10,6 kΩ",
    description: "Sinal condicionado do sensor de pressão hidráulica usado na análise de frenagem e pelo BSPD."
  },
  {
    key: "steering-angle", channel: "ADC-04", name: "Ângulo do volante", side: "left",
    typeLabel: "Analógico bidirecional", idealLabel: "0,50–4,50 V", base: 2.47, swing: 0.10,
    min: 0.50, max: 4.50, decimals: 2, simulationState: "ok", color: "#64d8cb",
    source: "Sensor da coluna de direção", destination: "ADC1_CH3 • P1.04", impedance: "14,1 kΩ",
    description: "Informa a posição angular do volante para correlação com aceleração lateral e deformação do chassi."
  },
  {
    key: "sensor5v", channel: "PWR-01", name: "Referência dos sensores 5 V", side: "left",
    typeLabel: "Alimentação regulada", idealLabel: "4,85–5,15 V", base: 5.02, faultBase: 5.65, swing: 0.04,
    min: 4.85, max: 5.15, decimals: 2, simulationState: "fault", color: "var(--red)",
    source: "Regulador de referência 5 V", destination: "Barramento SENS_5V • P1.05", impedance: "0,82 kΩ equiv.",
    description: "Alimentação comum dos sensores analógicos. A leitura simulada está acima do limite e faz este fio piscar."
  },
  {
    key: "hvil", channel: "SAFE-01", name: "Intertravamento HVIL", side: "top",
    typeLabel: "Digital 5 V • HIGH", idealLabel: "4,50–5,20 V", base: 5.00, swing: 0.03,
    min: 4.50, max: 5.20, decimals: 2, simulationState: "ok", color: "#eef3f5",
    source: "Loop HVIL do acumulador", destination: "GPIO34 • P2.01", impedance: "46,8 kΩ",
    description: "Confirma a continuidade do intertravamento de alta tensão antes de permitir o fechamento dos contatores."
  },
  {
    key: "shutdown-loop", channel: "SAFE-02", name: "Retorno do shutdown circuit", side: "top",
    typeLabel: "Digital 5 V condicionado", idealLabel: "4,50–5,20 V", base: 5.01, swing: 0.04,
    min: 4.50, max: 5.20, decimals: 2, simulationState: "ok", color: "#9ce8d8",
    source: "Circuito de desligamento", destination: "GPIO35 • P2.02", impedance: "47,2 kΩ",
    description: "Retorno condicionado da cadeia de segurança que reúne botões de emergência e permissões críticas."
  },
  {
    key: "imd-ok", channel: "SAFE-03", name: "Permissão IMD", side: "top",
    typeLabel: "Digital 5 V • HIGH", idealLabel: "4,50–5,20 V", base: 4.98, swing: 0.04,
    min: 4.50, max: 5.20, decimals: 2, simulationState: "ok", color: "#b7c4ca",
    source: "Insulation Monitoring Device", destination: "GPIO32 • P2.03", impedance: "47,0 kΩ",
    description: "Indica que o monitor de isolamento não detectou resistência insegura entre o sistema HV e o chassi."
  },
  {
    key: "ams-ok", channel: "SAFE-04", name: "Permissão AMS", side: "top",
    typeLabel: "Digital 5 V • HIGH", idealLabel: "4,50–5,20 V", base: 5.00, swing: 0.04,
    min: 4.50, max: 5.20, decimals: 2, simulationState: "ok", color: "var(--purple)",
    source: "Accumulator Management System", destination: "GPIO33 • P2.04", impedance: "46,9 kΩ",
    description: "Sinal de integridade do gerenciamento do acumulador para a cadeia de desligamento do veículo."
  },
  {
    key: "bspd-ok", channel: "SAFE-05", name: "Permissão BSPD", side: "top",
    typeLabel: "Digital 5 V • HIGH", idealLabel: "4,50–5,20 V", base: 4.99, swing: 0.04,
    min: 4.50, max: 5.20, decimals: 2, simulationState: "ok", color: "var(--accent)",
    source: "Brake System Plausibility Device", destination: "GPIO25 • P2.05", impedance: "47,3 kΩ",
    description: "Permissão do circuito de plausibilidade entre pressão de freio e solicitação de torque."
  },
  {
    key: "inverter-ready", channel: "IN-01", name: "Inversor pronto", side: "top",
    typeLabel: "Digital 5 V • HIGH", idealLabel: "4,50–5,20 V", base: 4.97, swing: 0.04,
    min: 4.50, max: 5.20, decimals: 2, simulationState: "ok", color: "#ffad5c",
    source: "Saída READY do inversor", destination: "GPIO26 • P2.06", impedance: "47,1 kΩ",
    description: "Canal discreto legado mantido durante o desenvolvimento. Esta função deverá futuramente ser recebida como mensagem da rede CAN."
  },
  {
    key: "aux12v", channel: "PWR-02", name: "Alimentação auxiliar 12 V", side: "right",
    typeLabel: "Alimentação LV", idealLabel: "11,50–13,80 V", base: 12.40, swing: 0.25,
    min: 11.50, max: 13.80, decimals: 2, simulationState: "ok", color: "var(--purple)",
    source: "Bateria LV / DC-DC", destination: "Barramento AUX_12V • P3.01", impedance: "0,34 kΩ equiv.",
    description: "Barramento de baixa tensão que alimenta eletrônica, sensores e atuadores auxiliares do carro."
  },
  {
    key: "inverter-enable", channel: "OUT-01", name: "Enable do inversor", side: "right",
    typeLabel: "Digital 12 V • HIGH", idealLabel: "10,50–13,80 V", base: 12.10, swing: 0.12,
    min: 10.50, max: 13.80, decimals: 2, simulationState: "ok", color: "var(--green)",
    source: "VCU • estágio de saída", destination: "Inversor • P3.02", impedance: "6,8 kΩ",
    description: "Comando que habilita o estágio de potência do inversor após a validação de toda a cadeia de segurança."
  },
  {
    key: "can-high", channel: "CAN-01", name: "Rede CAN — CAN-H", side: "right",
    typeLabel: "CAN diferencial • linha alta", idealLabel: "2,40–3,70 V", base: 3.18, swing: 0.20,
    min: 2.40, max: 3.70, decimals: 2, simulationState: "ok", color: "var(--blue)",
    visualClass: "wire-can wire-can-high",
    source: "Barramento CAN do sistema trativo", destination: "Transceptor CAN • P3.03", impedance: "60 Ω diferencial",
    description: "Condutor CAN-H do par trançado. Sua tensão sobe durante o estado dominante da comunicação CAN."
  },
  {
    key: "can-low", channel: "CAN-02", name: "Rede CAN — CAN-L", side: "right",
    typeLabel: "CAN diferencial • linha baixa", idealLabel: "1,30–2,60 V", base: 1.82, swing: 0.20,
    min: 1.30, max: 2.60, decimals: 2, simulationState: "ok", color: "#f4f7f8",
    visualClass: "wire-can wire-can-low",
    source: "Barramento CAN do sistema trativo", destination: "Transceptor CAN • P3.04", impedance: "60 Ω diferencial",
    description: "Condutor CAN-L do par trançado. Trabalha de forma complementar ao CAN-H para rejeitar ruído elétrico."
  },
  {
    key: "can-shield", channel: "CAN-SH", name: "Rede CAN — Shield", side: "right",
    typeLabel: "Blindagem EMC / referência", idealLabel: "0,00–0,15 V", base: 0.03, swing: 0.02,
    min: 0.00, max: 0.15, decimals: 2, simulationState: "ok", color: "#89949a",
    visualClass: "wire-can-shield",
    source: "Malha externa do cabo CAN", destination: "Chassi / referência EMC • P3.05", impedance: "< 0,5 Ω ao chassi",
    description: "Blindagem do cabo CAN, conectada conforme a estratégia EMC para reduzir interferência sem conduzir os dados diferenciais."
  },
  {
    key: "fan-command", channel: "OUT-03", name: "Comando da ventoinha", side: "right",
    typeLabel: "Digital 12 V • HIGH", idealLabel: "10,50–13,80 V", base: 12.00, swing: 0.15,
    min: 10.50, max: 13.80, decimals: 2, simulationState: "ok", color: "#f0d98c",
    source: "Módulo de acionamento LV", destination: "Relé da ventoinha • P3.06", impedance: "79 Ω equiv.",
    description: "Comando elétrico da ventoinha do radiador, supervisionado para identificar queda de tensão no chicote."
  },
  {
    key: "precharge-relay", channel: "HV-OUT-01", name: "Relé de pré-carga", side: "bottom",
    typeLabel: "Digital 12 V • HIGH", idealLabel: "10,50–13,80 V", base: 12.10, swing: 0.12,
    min: 10.50, max: 13.80, decimals: 2, simulationState: "ok", color: "#68d5ff",
    source: "VCU • driver de pré-carga", destination: "Bobina K_PRE • P4.01", impedance: "88 Ω",
    description: "Aciona o relé que limita a corrente de carga dos capacitores do inversor antes do fechamento principal."
  },
  {
    key: "contactor-positive", channel: "HV-OUT-02", name: "Contator principal positivo", side: "bottom",
    typeLabel: "Digital 12 V • HIGH", idealLabel: "10,50–13,80 V", base: 12.20, swing: 0.12,
    min: 10.50, max: 13.80, decimals: 2, simulationState: "ok", color: "var(--accent)",
    source: "VCU • driver AIR+", destination: "Bobina AIR+ • P4.02", impedance: "91 Ω",
    description: "Linha de comando do contator positivo do acumulador de alta tensão."
  },
  {
    key: "contactor-negative", channel: "HV-OUT-03", name: "Contator principal negativo", side: "bottom",
    typeLabel: "Digital 12 V • HIGH", idealLabel: "10,50–13,80 V", base: 12.00, swing: 0.12,
    min: 10.50, max: 13.80, decimals: 2, simulationState: "ok", color: "#b39cff",
    source: "VCU • driver AIR−", destination: "Bobina AIR− • P4.03", impedance: "90 Ω",
    description: "Linha de comando do contator negativo do acumulador de alta tensão."
  },
  {
    key: "brake-switch", channel: "IN-02", name: "Chave do pedal de freio", side: "bottom",
    typeLabel: "Digital 12 V • HIGH", idealLabel: "10,50–13,80 V", base: 12.10, swing: 0.08,
    min: 10.50, max: 13.80, decimals: 2, simulationState: "disconnected", color: "var(--red)",
    source: "Chave mecânica do pedal", destination: "GPIO27 • P4.04", impedance: "12,6 kΩ",
    description: "O canal está simulado em alta impedância, representando fio rompido, conector solto ou contato aberto inesperado."
  },
  {
    key: "tsal-command", channel: "OUT-04", name: "Comando TSAL", side: "bottom",
    typeLabel: "Digital 12 V • HIGH", idealLabel: "10,50–13,80 V", base: 12.10, swing: 0.12,
    min: 10.50, max: 13.80, decimals: 2, simulationState: "ok", color: "#f4f7f8",
    source: "VCU • saída de estado HV", destination: "TSAL • P4.05", impedance: "1,4 kΩ",
    description: "Comando supervisionado da luz de estado do sistema trativo de alta tensão."
  },
  {
    key: "cooling-pump", channel: "OUT-02", name: "Bomba de arrefecimento", side: "bottom",
    typeLabel: "Digital 12 V • HIGH", idealLabel: "10,50–13,80 V", base: 12.20, swing: 0.15,
    min: 10.50, max: 13.80, decimals: 2, simulationState: "ok", color: "#57d99a",
    source: "Módulo de acionamento LV", destination: "Relé da bomba • P4.06", impedance: "72 Ω equiv.",
    description: "Canal discreto legado mantido durante o desenvolvimento. O comando da bomba deverá futuramente migrar para uma mensagem CAN."
  }
];

const navItems = document.querySelectorAll(".nav-item");
const navItemByPage = new Map(
  Array.from(navItems, (item) => [item.dataset.page, item])
);
const pages = document.querySelectorAll(".page");
const pageTitle = document.getElementById("pageTitle");
const pauseButton = document.getElementById("pauseButton");
const timer = document.getElementById("sessionTimer");
const appShell = document.querySelector(".app-shell");
const mainArea = document.querySelector(".main");
const toast = document.getElementById("toast");
const connectionCard = document.getElementById("connectionCard");
const connectionButton = document.getElementById("connectionButton");
const compactConnectionButton = document.getElementById("compactConnectionButton");
const connectionTransport = document.getElementById("connectionTransport");
const connectionStateText = document.getElementById("connectionState");
const connectionModal = document.getElementById("connectionModal");
const connectionForm = document.getElementById("connectionForm");
const connectionClose = document.getElementById("connectionClose");
const connectionCancel = document.getElementById("connectionCancel");
const dataSourceSelect = document.getElementById("dataSourceSelect");
const backendUrlInput = document.getElementById("backendUrl");
const backendUrlField = document.querySelector(".backend-url-field");
const connectionSourceNote = document.getElementById("connectionSourceNote");
const mqttConnectionSummary = document.getElementById("mqttConnectionSummary");
const footerConnectionText = document.getElementById("footerConnectionText");
const footerStatusDot = document.getElementById("footerStatusDot");
const mqttProtocolLane = document.querySelector(".mqtt-protocol-lane");
const recordingIndicator = document.getElementById("recordingIndicator");
const recordingState = document.getElementById("recordingState");
const liveTag = document.getElementById("liveTag");
const telemetryAlertAnnouncer = document.getElementById("telemetryAlertAnnouncer");
const tireStatusElements = new Map(
  Array.from(document.querySelectorAll("[data-tire-status]"), (element) => [element.dataset.tireStatus, element])
);
const brakeOnlineStatus = document.querySelector('[data-brake-status="online"]');
const brakeAlertStatus = document.querySelector('[data-brake-status="alert"]');
const chipHarness = document.getElementById("chipHarness");
const wireDetailPanel = document.getElementById("wireDetailPanel");
const wireDetailClose = document.getElementById("wireDetailClose");
const wireByKey = new Map(wireDefinitions.map((wire) => [wire.key, wire]));
const allowedTelemetryValues = new Set(
  Array.from(document.querySelectorAll("[data-value]"), (element) => element.dataset.value)
);
const frontendManagedValues = new Set([
  "mqtt-status",
  "mqtt-latency",
  "packet-loss",
  "rssi",
  "wire-ok-count",
  "wire-total-count"
]);
const textualTelemetryValues = new Set(["roll", "yaw"]);
const legacyWireValueMap = {
  "wire-aps1": "aps1",
  "wire-aps2": "aps2",
  "wire-sensor5v": "sensor5v",
  "wire-aux12v": "aux12v",
  "wire-hvil": "hvil",
  "wire-inverter-enable": "inverter-enable",
  "wire-brake-switch": "brake-switch"
};
const numericTelemetryRules = [
  { pattern: /^(speed|wheel-(fl|fr|rl|rr))$/, min: -500, max: 500 },
  { pattern: /^rpm$/, min: -50000, max: 50000 },
  { pattern: /^(torque|power)$/, min: -10000, max: 10000 },
  { pattern: /^susp-(fl|fr|rl|rr)$/, min: -1000, max: 1000 },
  { pattern: /^(temp-(fl|fr|rl|rr)|bearing-temp)$/, min: -100, max: 1000 },
  { pattern: /^tire-pressure-(fl|fr|rl|rr)$/, min: 0, max: 30 },
  { pattern: /^g-(lat|long)$/, min: -50, max: 50 },
  { pattern: /^chassis-lat$/, min: -1000, max: 1000 },
  { pattern: /^chassis-twist$/, min: -360, max: 360 },
  { pattern: /^(delta-chassis|strain-(left|right|center|rear|peak))$/, min: -1e9, max: 1e9 },
  { pattern: /^brake-(front|rear|fl|fr|rl|rr)$/, min: 0, max: 1000 },
  { pattern: /^(brake-pedal|brake-bias|regen|bearing-health)$/, min: 0, max: 100 },
  { pattern: /^(bearing-rms|bearing-peak)$/, min: 0, max: 1e6 },
  { pattern: /^bearing-frequency$/, min: 0, max: 1e6 }
];
const brakeGraphicDefinitions = {
  "brake-front": { selector: '[data-brake-visual="front"]', property: "--line-pressure", maximum: 100 },
  "brake-rear": { selector: '[data-brake-visual="rear"]', property: "--line-pressure", maximum: 100 },
  "brake-pedal": { selector: '[data-brake-visual="pedal"]', property: "--pedal-position", maximum: 100 }
};
const monitoredAlertPages = [
  "suspension",
  "tires",
  "dynamics",
  "chassis",
  "brakes",
  "bearing",
  "development"
];
const alertTelemetryKeys = new Set([
  "susp-fl", "susp-fr", "susp-rl", "susp-rr",
  "temp-fl", "temp-fr", "temp-rl", "temp-rr",
  "tire-pressure-fl", "tire-pressure-fr", "tire-pressure-rl", "tire-pressure-rr",
  "speed", "rpm",
  "chassis-lat", "chassis-twist", "delta-chassis",
  "strain-left", "strain-right", "strain-center", "strain-rear", "strain-peak",
  "brake-front", "brake-rear", "brake-fl", "brake-fr", "brake-rl", "brake-rr", "brake-pedal",
  "bearing-rms", "bearing-peak", "bearing-temp", "bearing-health"
]);
// Limites provisórios do protótipo. Substituir pelos limites validados pela equipe de engenharia.
const prototypeAlertLimits = Object.freeze({
  suspension: { minimumMm: 0, maximumMm: 100 },
  tires: { minimumTemperatureC: -20, maximumTemperatureC: 120, minimumPressureBar: 1, maximumPressureBar: 4 },
  dynamics: { maximumSpeedKmh: 250, maximumMotorRpm: 10000 },
  chassis: { maximumLateralMm: 1, maximumTwistDeg: 1, maximumStrainMicro: 300, maximumDeltaMicro: 200 },
  brakes: { maximumPressureBar: 1000, maximumPedalPercent: 100 },
  bearing: { maximumRmsMmS: 4.5, maximumPeakG: 8, maximumTemperatureC: 90, minimumHealthPercent: 60 }
});
const alertTelemetryValues = new Map();
const navigationAlertStates = new Map();
const pendingAlertAnnouncements = new Map();
const wireRuntime = new Map();
const harnessSlotsPerSide = 6;
let selectedWireKey = null;
let telemetrySocket = null;
let reconnectTimer = null;
let staleTimer = null;
let alertAnnouncementTimer = null;
let connectionModalTrigger = connectionButton;
let connectionFormWasInverter = false;

function renderHarnessWires() {
  document.querySelectorAll("[data-wire-group]").forEach((group) => {
    const side = group.dataset.wireGroup;
    const fragment = document.createDocumentFragment();
    const sideWires = wireDefinitions.filter((wire) => wire.side === side);

    sideWires.forEach((wire) => {
        const button = document.createElement("button");

        button.type = "button";
        button.className = `wire-visual${wire.visualClass ? ` ${wire.visualClass}` : ""}`;
        button.dataset.wireVisual = wire.key;
        button.style.setProperty("--wire", wire.color);
        button.title = `${wire.name} — abrir dados elétricos`;
        button.setAttribute("aria-label", `Abrir dados elétricos de ${wire.name}`);
        button.setAttribute("aria-controls", "wireDetailPanel");
        button.setAttribute("aria-expanded", "false");

        fragment.append(button);
      });

    for (let slot = sideWires.length; slot < harnessSlotsPerSide; slot += 1) {
      const emptySlot = document.createElement("span");
      emptySlot.className = "wire-slot-empty";
      emptySlot.setAttribute("aria-hidden", "true");
      fragment.append(emptySlot);
    }

    group.replaceChildren(fragment);
  });
}

function setWireDetailText(selector, value) {
  const element = wireDetailPanel?.querySelector(selector);

  if (element) {
    element.textContent = value;
  }
}

function renderWireDetail(key) {
  const wire = wireByKey.get(key);

  if (!wire || !wireDetailPanel) return;

  const runtime = wireRuntime.get(key);
  const noData = state.source !== "simulation" && (!runtime || runtime.status === "no-data");
  const status = noData ? "no-data" : runtime?.status ?? wire.simulationState ?? "ok";
  const disconnected = status === "disconnected";
  const warning = status === "fault";
  const statusLabel = noData
    ? "AGUARDANDO DADO"
    : disconnected
    ? "ALTA IMPEDÂNCIA"
    : warning
      ? "FORA DA FAIXA"
      : "OK";
  const voltage = noData
    ? "--"
    : disconnected
    ? "HI-Z"
    : runtime?.value != null
      ? runtime.value.toFixed(wire.decimals)
      : wire.base.toFixed(wire.decimals);
  const updatedAt = runtime?.updatedAt
    ? runtime.updatedAt.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
        hour12: false
      })
    : "Aguardando amostra";

  setWireDetailText("[data-detail-channel]", `${wire.channel} • ${wire.side.toUpperCase()}`);
  setWireDetailText("[data-detail-name]", wire.name);
  setWireDetailText("[data-detail-voltage]", voltage);
  setWireDetailText("[data-detail-voltage-unit]", disconnected || noData ? "" : " V");
  setWireDetailText("[data-detail-status]", statusLabel);
  setWireDetailText("[data-detail-ideal]", wire.idealLabel);
  setWireDetailText("[data-detail-type]", wire.typeLabel);
  setWireDetailText("[data-detail-source]", wire.source);
  setWireDetailText("[data-detail-destination]", wire.destination);
  setWireDetailText(
    "[data-detail-impedance]",
    noData
      ? "Aguardando medição"
      : runtime?.impedanceLabel
        ?? (disconnected ? "> 1 MΩ • circuito aberto" : wire.impedance)
  );
  setWireDetailText("[data-detail-updated]", updatedAt);
  setWireDetailText("[data-detail-description]", wire.description);

  wireDetailPanel.style.setProperty("--detail-color", wire.color);
  wireDetailPanel.classList.toggle("detail-warn", warning);
  wireDetailPanel.classList.toggle("detail-disconnected", disconnected);
  wireDetailPanel.classList.toggle("detail-no-data", noData);

  const statusElement = wireDetailPanel.querySelector("[data-detail-status]");

  if (statusElement) {
    statusElement.classList.toggle("status-warn", warning);
    statusElement.classList.toggle("status-disconnected", disconnected);
    statusElement.classList.toggle("status-no-data", noData);
  }

  document.querySelectorAll("[data-wire-visual]").forEach((visualWire) => {
    const selected = visualWire.dataset.wireVisual === key;
    visualWire.classList.toggle("is-selected", selected);
    visualWire.setAttribute("aria-expanded", selected ? "true" : "false");
  });
}

function openWireDetail(key) {
  if (!wireByKey.has(key) || !wireDetailPanel) return;

  selectedWireKey = key;
  wireDetailPanel.classList.add("open");
  wireDetailPanel.setAttribute("aria-hidden", "false");
  renderWireDetail(key);
}

function closeWireDetail() {
  selectedWireKey = null;
  wireDetailPanel?.classList.remove("open");
  wireDetailPanel?.setAttribute("aria-hidden", "true");

  document.querySelectorAll("[data-wire-visual]").forEach((visualWire) => {
    visualWire.classList.remove("is-selected");
    visualWire.setAttribute("aria-expanded", "false");
  });
}

chipHarness?.addEventListener("click", (event) => {
  const visualWire = event.target.closest("[data-wire-visual]");

  if (visualWire) {
    openWireDetail(visualWire.dataset.wireVisual);
  }
});

wireDetailClose?.addEventListener("click", closeWireDetail);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && selectedWireKey) {
    closeWireDetail();
  }
});

function renderNavigationAlert(pageId, active, reason = "") {
  const navItem = navItemByPage.get(pageId);
  if (!navItem) return;

  const baseLabel = pageNames[pageId] ?? pageId;
  if (pageId === "overview" || pageId === "database") {
    navItem.dataset.alert = "false";
    navItem.setAttribute("aria-label", baseLabel);
    navItem.removeAttribute("title");
    return;
  }

  const hasAlert = Boolean(active);
  const alertReason = reason || "falha detectada no monitoramento";
  navItem.dataset.alert = hasAlert ? "true" : "false";
  navItem.setAttribute(
    "aria-label",
    hasAlert ? `${baseLabel}. Alerta: ${alertReason}` : baseLabel
  );

  if (hasAlert) {
    navItem.title = `ALERTA — ${alertReason}`;
  } else {
    navItem.removeAttribute("title");
  }
}

function queueNavigationAlertAnnouncement(pageId, message) {
  if (!telemetryAlertAnnouncer) return;
  pendingAlertAnnouncements.set(pageId, message);
  if (alertAnnouncementTimer) return;

  alertAnnouncementTimer = setTimeout(() => {
    alertAnnouncementTimer = null;
    telemetryAlertAnnouncer.textContent = Array.from(pendingAlertAnnouncements.values()).join(" ");
    pendingAlertAnnouncements.clear();
  }, 0);
}

function setNavigationAlert(pageId, active, reason = "", announce = true) {
  if (!monitoredAlertPages.includes(pageId) || pageId === "database") return;

  const nextState = { active: Boolean(active), reason: active ? reason : "" };
  const previousState = navigationAlertStates.get(pageId) ?? { active: false, reason: "" };
  const stateChanged = previousState.active !== nextState.active;
  const reasonChanged = previousState.reason !== nextState.reason;

  if (!stateChanged && !reasonChanged) return;

  navigationAlertStates.set(pageId, nextState);
  renderNavigationAlert(pageId, nextState.active, nextState.reason);

  if (announce && stateChanged) {
    const message = nextState.active
      ? `Alerta em ${pageNames[pageId]}: ${nextState.reason}.`
      : `Alerta normalizado em ${pageNames[pageId]}.`;
    queueNavigationAlertAnnouncement(pageId, message);
  }
}

function initializeNavigationAlerts() {
  navItems.forEach((navItem) => {
    const pageId = navItem.dataset.page;
    navItem.dataset.alert = "false";
    navItem.setAttribute("aria-controls", pageId);
    navItem.setAttribute("aria-label", pageNames[pageId] ?? pageId);

    if (navItem.classList.contains("active")) {
      navItem.setAttribute("aria-current", "page");
    } else {
      navItem.removeAttribute("aria-current");
    }
  });

  monitoredAlertPages.forEach((pageId) => {
    navigationAlertStates.set(pageId, { active: false, reason: "" });
  });
  renderNavigationAlert("overview", false);
  renderNavigationAlert("database", false);
}

function resetNavigationAlerts() {
  alertTelemetryValues.clear();
  monitoredAlertPages.forEach((pageId) => {
    navigationAlertStates.set(pageId, { active: false, reason: "" });
    renderNavigationAlert(pageId, false);
  });
  renderNavigationAlert("database", false);
  renderNavigationAlert("overview", false);
  if (alertAnnouncementTimer) clearTimeout(alertAnnouncementTimer);
  alertAnnouncementTimer = null;
  pendingAlertAnnouncements.clear();
  if (telemetryAlertAnnouncer) telemetryAlertAnnouncer.textContent = "";
}

function alertTelemetryNumber(name, value) {
  if (
    name === "rpm"
    && typeof value === "string"
    && /^-?\d{1,3}(?:\.\d{3})+$/.test(value.trim())
  ) {
    return Number(value.replaceAll(".", ""));
  }

  return telemetryNumber(value);
}

function cacheAlertTelemetryValue(name, value) {
  if (!alertTelemetryKeys.has(name)) return;

  const number = alertTelemetryNumber(name, value);
  if (number === null) {
    alertTelemetryValues.delete(name);
  } else {
    alertTelemetryValues.set(name, number);
  }
}

function cacheAlertTelemetryValues(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return;
  Object.entries(values).forEach(([name, value]) => cacheAlertTelemetryValue(name, value));
}

function evaluateTelemetryNavigationAlerts() {
  const firstMatchingMetric = (keys, predicate) => keys.find((key) => {
    const value = alertTelemetryValues.get(key);
    return Number.isFinite(value) && predicate(value, key);
  });

  const suspensionKeys = ["susp-fl", "susp-fr", "susp-rl", "susp-rr"];
  const suspensionFault = firstMatchingMetric(suspensionKeys, (value) => (
    value < prototypeAlertLimits.suspension.minimumMm
    || value > prototypeAlertLimits.suspension.maximumMm
  ));
  setNavigationAlert(
    "suspension",
    Boolean(suspensionFault),
    "curso da suspensão fora da faixa provisória de 0 a 100 mm"
  );

  const tireTemperatureFault = firstMatchingMetric(
    ["temp-fl", "temp-fr", "temp-rl", "temp-rr"],
    (value) => value < prototypeAlertLimits.tires.minimumTemperatureC
      || value > prototypeAlertLimits.tires.maximumTemperatureC
  );
  const tirePressureFault = firstMatchingMetric(
    ["tire-pressure-fl", "tire-pressure-fr", "tire-pressure-rl", "tire-pressure-rr"],
    (value) => value < prototypeAlertLimits.tires.minimumPressureBar
      || value > prototypeAlertLimits.tires.maximumPressureBar
  );
  setNavigationAlert(
    "tires",
    Boolean(tireTemperatureFault || tirePressureFault),
    tireTemperatureFault ? "temperatura de pneu fora da faixa" : "pressão de pneu fora da faixa"
  );

  const speed = alertTelemetryValues.get("speed");
  const rpm = alertTelemetryValues.get("rpm");
  const dynamicsFault = (Number.isFinite(speed) && Math.abs(speed) > prototypeAlertLimits.dynamics.maximumSpeedKmh)
    || (Number.isFinite(rpm) && Math.abs(rpm) > prototypeAlertLimits.dynamics.maximumMotorRpm);
  setNavigationAlert(
    "dynamics",
    dynamicsFault,
    Number.isFinite(speed) && Math.abs(speed) > prototypeAlertLimits.dynamics.maximumSpeedKmh
      ? "velocidade acima do limite provisório"
      : "rotação do motor acima do limite provisório"
  );

  const lateral = alertTelemetryValues.get("chassis-lat");
  const twist = alertTelemetryValues.get("chassis-twist");
  const delta = alertTelemetryValues.get("delta-chassis");
  const strainFault = firstMatchingMetric(
    ["strain-left", "strain-right", "strain-center", "strain-rear", "strain-peak"],
    (value) => Math.abs(value) > prototypeAlertLimits.chassis.maximumStrainMicro
  );
  const chassisFault = (Number.isFinite(lateral) && Math.abs(lateral) > prototypeAlertLimits.chassis.maximumLateralMm)
    || (Number.isFinite(twist) && Math.abs(twist) > prototypeAlertLimits.chassis.maximumTwistDeg)
    || (Number.isFinite(delta) && Math.abs(delta) > prototypeAlertLimits.chassis.maximumDeltaMicro)
    || Boolean(strainFault);
  setNavigationAlert(
    "chassis",
    chassisFault,
    "deformação do chassi acima do limite provisório"
  );

  const brakePressureFault = firstMatchingMetric(
    ["brake-front", "brake-rear", "brake-fl", "brake-fr", "brake-rl", "brake-rr"],
    (value) => value < 0 || value > prototypeAlertLimits.brakes.maximumPressureBar
  );
  const brakePedal = alertTelemetryValues.get("brake-pedal");
  const brakePedalFault = Number.isFinite(brakePedal)
    && (brakePedal < 0 || brakePedal > prototypeAlertLimits.brakes.maximumPedalPercent);
  setNavigationAlert(
    "brakes",
    Boolean(brakePressureFault || brakePedalFault),
    brakePedalFault ? "posição do pedal fora da faixa" : "pressão de freio fora da faixa"
  );

  const bearingRms = alertTelemetryValues.get("bearing-rms");
  const bearingPeak = alertTelemetryValues.get("bearing-peak");
  const bearingTemperature = alertTelemetryValues.get("bearing-temp");
  const bearingHealth = alertTelemetryValues.get("bearing-health");
  const bearingFault = (Number.isFinite(bearingRms) && bearingRms > prototypeAlertLimits.bearing.maximumRmsMmS)
    || (Number.isFinite(bearingPeak) && bearingPeak > prototypeAlertLimits.bearing.maximumPeakG)
    || (Number.isFinite(bearingTemperature) && bearingTemperature > prototypeAlertLimits.bearing.maximumTemperatureC)
    || (Number.isFinite(bearingHealth) && bearingHealth < prototypeAlertLimits.bearing.minimumHealthPercent);
  setNavigationAlert(
    "bearing",
    bearingFault,
    "vibração, temperatura ou saúde do mancal em condição crítica"
  );
}

function refreshHarnessNavigationAlert() {
  const failures = Array.from(wireRuntime.entries()).filter(([, runtime]) => (
    runtime.status === "fault" || runtime.status === "disconnected"
  ));
  const firstFailureName = failures.length > 0
    ? wireByKey.get(failures[0][0])?.name
    : "";
  const reason = failures.length === 1
    ? `${firstFailureName || "um fio"} com falha`
    : `${failures.length} fios com falha ou alta impedância`;

  setNavigationAlert("development", failures.length > 0, reason);
}

function showPage(pageId) {
  pages.forEach((page) => page.classList.toggle("active", page.id === pageId));
  navItems.forEach((item) => {
    const isActive = item.dataset.page === pageId;
    item.classList.toggle("active", isActive);
    if (isActive) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  pageTitle.textContent = pageNames[pageId];

  mainArea.classList.toggle("development-wide", pageId === "development");

  window.scrollTo({ top: 0, behavior: "smooth" });
}

navItems.forEach((item) => item.addEventListener("click", () => showPage(item.dataset.page)));
document.querySelectorAll("[data-go]").forEach((card) => {
  card.addEventListener("click", () => showPage(card.dataset.go));
});

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const secs = (seconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${secs}`;
}

function setAll(name, value) {
  if (!/^[a-z0-9-]+$/i.test(String(name))) return;
  cacheAlertTelemetryValue(name, value);

  document.querySelectorAll(`[data-value="${name}"]`).forEach((element) => {
    element.textContent = value;
    element.classList.remove("data-stale");
  });

  updateBrakeGraphic(name, value);
}

function updateBrakeGraphic(name, value) {
  const definition = brakeGraphicDefinitions[name];
  if (!definition) return;

  const visual = document.querySelector(definition.selector);
  if (!visual) return;

  const number = Number(value);
  const hasValue = value !== null && value !== undefined && value !== "" && Number.isFinite(number);
  const percentage = hasValue
    ? Math.max(0, Math.min(100, (number / definition.maximum) * 100))
    : 0;

  visual.style.setProperty(definition.property, `${percentage}%`);
  visual.classList.toggle("no-data", !hasValue);
}

function fluctuate(base, amount, decimals = 0) {
  return Number((base + (Math.random() - 0.5) * amount).toFixed(decimals));
}

function setCss(name, value) {
  document.documentElement.style.setProperty(name, value);
}

function telemetryNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isValidFrontendValue(name, value) {
  if (textualTelemetryValues.has(name)) {
    return ["number", "string"].includes(typeof value) && String(value).length <= 32;
  }

  const number = telemetryNumber(value);
  if (number === null) return false;

  const rule = numericTelemetryRules.find(({ pattern }) => pattern.test(name));
  return !rule || (number >= rule.min && number <= rule.max);
}

function setSensorBadge(element, label, tone) {
  if (!element) return;
  element.textContent = label;
  element.classList.remove("good", "warm", "bad", "no-data");
  if (tone) element.classList.add(tone);
}

function setDiagnosticsNoData() {
  tireStatusElements.forEach((element) => setSensorBadge(element, "SEM DADOS", "no-data"));
  setSensorBadge(brakeOnlineStatus, "SEM DADOS", "no-data");

  if (brakeAlertStatus) {
    brakeAlertStatus.textContent = "SEM DADOS";
    brakeAlertStatus.classList.remove("diagnostic-good", "diagnostic-bad");
    brakeAlertStatus.classList.add("data-stale");
  }
}

function restoreSimulationDiagnostics() {
  const simulationTireStates = {
    fl: ["ESTÁVEL", "good"],
    fr: ["ESTÁVEL", "good"],
    rl: ["AQUECENDO", "warm"],
    rr: ["ESTÁVEL", "good"]
  };

  tireStatusElements.forEach((element, key) => {
    const [label, tone] = simulationTireStates[key] ?? ["ESTÁpVEL", "good"];
    setSensorBadge(element, label, tone);
  });
  setSensorBadge(brakeOnlineStatus, "ONLINE", "good");

  if (brakeAlertStatus) {
    brakeAlertStatus.textContent = "OK";
    brakeAlertStatus.classList.remove("data-stale", "diagnostic-bad");
    brakeAlertStatus.classList.add("diagnostic-good");
  }
}

function updateDiagnosticsFromTelemetry(values) {
  ["fl", "fr", "rl", "rr"].forEach((key) => {
    const temperature = telemetryNumber(values[`temp-${key}`]);
    const pressure = telemetryNumber(values[`tire-pressure-${key}`]);
    if (temperature === null && pressure === null) return;

    const alert = (temperature !== null && (temperature < -20 || temperature > 120))
      || (pressure !== null && (pressure < 1 || pressure > 4));
    const warming = !alert && temperature !== null && temperature < 70;
    setSensorBadge(
      tireStatusElements.get(key),
      alert ? "ALERTA" : warming ? "AQUECENDO" : "ESTÃVEL",
      alert ? "bad" : warming ? "warm" : "good"
    );
  });

  const brakeKeys = ["brake-front", "brake-rear", "brake-fl", "brake-fr", "brake-rl", "brake-rr", "brake-pedal"];
  const brakeSamples = brakeKeys
    .map((key) => ({ key, value: telemetryNumber(values[key]) }))
    .filter(({ value }) => value !== null);
  if (brakeSamples.length === 0) return;

  setSensorBadge(brakeOnlineStatus, "ONLINE", "good");
  const brakeFault = brakeSamples.some(({ key, value }) => (
    value < 0 || value > (key === "brake-pedal" ? 100 : 1000)
  ));

  if (brakeAlertStatus) {
    brakeAlertStatus.textContent = brakeFault ? "ALERTA" : "OK";
    brakeAlertStatus.classList.remove("data-stale", "diagnostic-good", "diagnostic-bad");
    brakeAlertStatus.classList.add(brakeFault ? "diagnostic-bad" : "diagnostic-good");
  }
}

function updateConnectionUi(status, detail) {
  const source = sourceDefinitions[state.source] ?? sourceDefinitions.simulation;
  state.connectionState = status;
  connectionCard.dataset.state = status;
  connectionTransport.textContent = source.label;
  connectionStateText.textContent = detail;
  footerConnectionText.textContent = status === "simulation" ? source.footer : detail;
  footerStatusDot.dataset.state = status;
  compactConnectionButton.dataset.state = status;
  compactConnectionButton.title = `${source.label} — ${detail}`;
  compactConnectionButton.setAttribute("aria-label", `Configurar entrada de dados. ${source.label}. ${detail}`);
  recordingIndicator.dataset.state = status;
  recordingState.textContent = status === "simulation"
    ? "DEMONSTRAÇÃO"
    : status === "online"
      ? "GRAVANDO"
      : "AGUARDANDO";
  liveTag.dataset.state = status;
  liveTag.textContent = status === "simulation"
    ? "DEMO"
    : status === "online"
      ? "LIVE"
      : status === "error"
        ? "ERRO"
        : "WAIT";

  if (state.source === "mqtt") {
    const mqttStatus = status === "online"
      ? "ONLINE"
      : status === "connecting"
        ? "CONECTANDO"
        : status === "waiting"
          ? "AGUARDANDO"
          : status === "error"
            ? "ERRO"
            : "OFFLINE";

    mqttProtocolLane.dataset.mqttState = status;
    setAll("mqtt-status", mqttStatus);
  } else {
    mqttProtocolLane.dataset.mqttState = "offline";
    setAll("mqtt-status", "OFFLINE");
    setAll("mqtt-latency", "--");
  }
}

function syncConnectionForm() {
  const sourceId = dataSourceSelect.value;
  const source = sourceDefinitions[sourceId] ?? sourceDefinitions.simulation;
  const isExternal = !["simulation", "inverter_demo"].includes(sourceId);

  backendUrlField.hidden = !isExternal;
  backendUrlInput.disabled = !isExternal;
  backendUrlInput.required = isExternal;
  connectionSourceNote.textContent = source.note;
  mqttConnectionSummary.hidden = sourceId !== "mqtt";
  const isInverter = sourceId === "inverter";
  const inverterKey = document.getElementById("inverterKey");
  document.getElementById("inverterKeyField").hidden = !isInverter;
  inverterKey.disabled = !isInverter;
  inverterKey.required = isInverter;
}

function openConnectionModal(event, sourceId = state.source) {
  connectionModalTrigger = event?.currentTarget ?? connectionButton;
  dataSourceSelect.value = sourceId;
  connectionFormWasInverter = sourceId === "inverter";
  backendUrlInput.value = connectionFormWasInverter ? state.inverterUrl : state.backendUrl;
  syncConnectionForm();
  connectionModal.hidden = false;
  appShell.inert = true;
  document.body.style.overflow = "hidden";
  dataSourceSelect.focus();
}

function closeConnectionModal() {
  connectionModal.hidden = true;
  document.getElementById("inverterKey").value = "";
  appShell.inert = false;
  document.body.style.removeProperty("overflow");
  connectionModalTrigger?.focus();
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function disconnectTelemetrySocket(manual = true) {
  clearReconnectTimer();
  state.manuallyDisconnected = manual;
  state.lastPacketAt = null;
  state.backendMode = null;

  if (telemetrySocket) {
    const socket = telemetrySocket;
    telemetrySocket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;

    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, "Fonte alterada pelo operador");
    }
  }
}

function prepareExternalTelemetry() {
  document.querySelectorAll("[data-value]").forEach((element) => {
    const name = element.dataset.value;
    if (["mqtt-status", "wire-total-count"].includes(name)) return;
    element.textContent = "--";
    element.classList.add("data-stale");
  });

  setCss("--speed-arc", "90");
  setCss("--g-x", "50%");
  setCss("--g-y", "50%");
  resetNavigationAlerts();
  updateBrakeGraphic("brake-front", null);
  updateBrakeGraphic("brake-rear", null);
  updateBrakeGraphic("brake-pedal", null);
  wireRuntime.clear();
  wireDefinitions.forEach((wire) => {
    setAll(`wire-${wire.key}`, "--");
    document.querySelectorAll(`[data-wire-visual="${wire.key}"]`).forEach((visualWire) => {
      visualWire.classList.remove("wire-error", "wire-disconnected");
      visualWire.classList.add("wire-no-data");
      visualWire.dataset.wireState = "no-data";
      visualWire.title = `${wire.name} • aguardando dado`;
    });
  });
  setAll("wire-ok-count", 0);
  setAll("wire-total-count", wireDefinitions.length);
  setDiagnosticsNoData();

  if (selectedWireKey) renderWireDetail(selectedWireKey);
}

function scheduleReconnect() {
  if (state.manuallyDisconnected || state.source === "simulation" || reconnectTimer) return;

  const delay = Math.min(15000, 1000 * (2 ** Math.min(state.reconnectAttempts, 4)));
  state.reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTelemetryBackend();
  }, delay);
}

function connectTelemetryBackend() {
  if (state.source === "simulation") return;

  let endpoint;
  try {
    endpoint = new URL(state.backendUrl);
  } catch {
    updateConnectionUi("error", "Endereço do receptor local inválido");
    showToast("Informe um endereço WebSocket válido, como ws://127.0.0.1:8787/ws");
    return;
  }

  if (!['ws:', 'wss:'].includes(endpoint.protocol)) {
    updateConnectionUi("error", "O receptor precisa usar ws:// ou wss://");
    showToast("O endereço do receptor deve começar com ws:// ou wss://");
    return;
  }

  disconnectTelemetrySocket(false);
  state.manuallyDisconnected = false;
  updateConnectionUi("connecting", "Conectando ao receptor local…");

  let socket;
  try {
    socket = new WebSocket(endpoint.href);
  } catch {
    updateConnectionUi("error", "Não foi possível criar a conexão WebSocket");
    showToast("Revise o endereço do receptor local");
    return;
  }
  telemetrySocket = socket;

  socket.onopen = () => {
    if (telemetrySocket !== socket) return;
    state.reconnectAttempts = 0;
    updateConnectionUi("waiting", "Receptor conectado; aguardando pacotes");
  };

  socket.onmessage = (event) => {
    if (telemetrySocket !== socket) return;

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      showToast("O receptor local enviou uma mensagem inválida");
      return;
    }

    handleBackendMessage(message);
  };

  socket.onerror = () => {
    if (telemetrySocket !== socket) return;
    updateConnectionUi("error", "Não foi possível acessar o receptor local");
  };

  socket.onclose = () => {
    if (telemetrySocket !== socket) return;
    telemetrySocket = null;
    updateConnectionUi("offline", "Receptor desconectado; nova tentativa automática");
    scheduleReconnect();
  };
}

function updateRealWireValue(key, measurement) {
  const wire = wireByKey.get(key);
  if (!wire) return;

  const structured = measurement && typeof measurement === "object";
  const rawValue = structured
    ? measurement.voltage_v ?? measurement.value_v ?? measurement.value
    : measurement;
  const missingValue = rawValue === null || rawValue === undefined || rawValue === "";
  const value = missingValue ? null : Number(rawValue);
  const declaredStatus = structured ? String(measurement.status ?? "").toLowerCase() : "";
  const supportedStatus = ["ok", "fault", "disconnected", "no-data"].includes(declaredStatus)
    ? declaredStatus
    : null;
  const disconnected = supportedStatus === "disconnected";
  const noData = supportedStatus === "no-data" || (supportedStatus === null && missingValue);

  if (!disconnected && !noData && !Number.isFinite(value)) return;

  const inRange = Number.isFinite(value) && value >= wire.min && value <= wire.max;
  const status = disconnected
    ? "disconnected"
    : noData
      ? "no-data"
      : !inRange || supportedStatus === "fault"
        ? "fault"
        : "ok";
  const effectiveValue = disconnected || noData ? null : value;
  const updatedAt = new Date();
  const impedanceValue = structured ? Number(measurement.impedance_ohm) : null;
  const impedanceLabel = structured && typeof measurement.impedance === "string"
    ? measurement.impedance
    : Number.isFinite(impedanceValue)
      ? impedanceValue >= 1_000_000
        ? `${(impedanceValue / 1_000_000).toFixed(1)} MΩ`
        : impedanceValue >= 1000
          ? `${(impedanceValue / 1000).toFixed(1)} kΩ`
          : `${impedanceValue.toFixed(0)} Ω`
      : null;

  wireRuntime.set(key, { value: Number.isFinite(effectiveValue) ? effectiveValue : null, status, updatedAt, impedanceLabel });
  setAll(`wire-${key}`, Number.isFinite(effectiveValue) ? effectiveValue.toFixed(wire.decimals) : "--");

  document.querySelectorAll(`[data-wire-visual="${key}"]`).forEach((visualWire) => {
    visualWire.classList.toggle("wire-no-data", status === "no-data");
    visualWire.classList.toggle("wire-disconnected", status === "disconnected");
    visualWire.classList.toggle("wire-error", status === "fault");
    visualWire.dataset.wireState = status;
    const label = status === "disconnected"
      ? "ALTA IMPEDÂNCIA"
      : status === "no-data"
        ? "AGUARDANDO DADO"
        : status === "fault"
          ? "FORA DA FAIXA"
          : "OK";
    visualWire.title = `${wire.name} • ${label}`;
    visualWire.setAttribute("aria-label", `${wire.name}. Estado: ${label}. Abrir dados elétricos.`);
  });

  const okCount = Array.from(wireRuntime.values()).filter((runtime) => runtime.status === "ok").length;
  setAll("wire-ok-count", okCount);
  setAll("wire-total-count", wireDefinitions.length);
  refreshHarnessNavigationAlert();
}

function applyHarnessChannels(harnessVoltage) {
  const channels = harnessVoltage?.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) return;

  Object.entries(channels).forEach(([key, measurement]) => {
    if (wireByKey.has(key)) updateRealWireValue(key, measurement);
  });
}

function applyFrontendValues(values = {}) {
  cacheAlertTelemetryValues(values);

  Object.entries(values).forEach(([name, value]) => {
    if (legacyWireValueMap[name]) {
      updateRealWireValue(legacyWireValueMap[name], value);
      return;
    }

    if (!allowedTelemetryValues.has(name) || frontendManagedValues.has(name)) return;
    if (!isValidFrontendValue(name, value)) return;
    setAll(name, value);
  });

  const speed = Number(values.speed);
  if (isValidFrontendValue("speed", values.speed)) {
    state.speed = speed;
    setCss("--speed-arc", `${Math.max(90, Math.min(520, speed * 2.05))}`);
  }

  const gLat = Number(values["g-lat"]);
  const gLong = Number(values["g-long"]);
  if (isValidFrontendValue("g-lat", values["g-lat"])) setCss("--g-x", `${50 + Math.max(-34, Math.min(34, gLat * 28))}%`);
  if (isValidFrontendValue("g-long", values["g-long"])) setCss("--g-y", `${50 - Math.max(-34, Math.min(34, gLong * 28))}%`);
  updateDiagnosticsFromTelemetry(values);
  evaluateTelemetryNavigationAlerts();
}

function calculateMessageLatency(message) {
  const timestamp = Number(message?.frame?.timestamp_ms);
  if (Number.isFinite(timestamp) && timestamp > 1_000_000_000_000) {
    return Math.max(0, Math.round(Date.now() - timestamp));
  }

  const receivedAt = Date.parse(message?.received_at);
  return Number.isFinite(receivedAt) ? Math.max(0, Math.round(Date.now() - receivedAt)) : null;
}

function expectedBackendMode() {
  if (state.expectedTransport === "mqtt") return "mqtt";
  if (["usb_serial", "usb_rf"].includes(state.expectedTransport)) return "serial";
  return "mock";
}

function normalizeIngestMode(value) {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");

  if (["mqtt", "mqtt_tls", "mqtt_cloud"].includes(normalized)) return "mqtt";
  if (["mock", "simulation", "simulated", "test"].includes(normalized)) return "mock";
  if ([
    "serial",
    "usb",
    "usb_serial",
    "usb_direct",
    "usb_rf",
    "usb_serial_rf_gateway"
  ].includes(normalized)) return "serial";
  return "unknown";
}

function detectedIngestMode(message) {
  const ingest = message?.ingest?.transport;
  if (ingest !== undefined && ingest !== null) return normalizeIngestMode(ingest);
  return normalizeIngestMode(message?.frame?.transport);
}

function isExpectedBackendMode(mode) {
  return mode !== "unknown" && (mode === "mock" || mode === expectedBackendMode());
}

function handleBackendMessage(message) {
  if (message.type === "snapshot") {
    const rawBackendMode = message.state?.mode;
    const backendMode = rawBackendMode === undefined || rawBackendMode === null
      ? null
      : normalizeIngestMode(rawBackendMode);
    const latest = message.state?.latest;

    state.backendMode = backendMode ?? null;
    if (backendMode === "unknown") {
      updateConnectionUi("error", `Modo desconhecido informado pelo receptor: ${String(rawBackendMode).slice(0, 24)}`);
      showToast("O receptor local informou um modo de entrada desconhecido");
      return;
    }
    if (backendMode && !isExpectedBackendMode(backendMode)) {
      const expectedLabel = expectedBackendMode() === "mqtt" ? "MQTT" : "serial USB/USB-RF";
      updateConnectionUi("error", `Receptor em modo ${backendMode}; esperado ${expectedLabel}`);
      showToast(`A fonte selecionada não corresponde ao modo ${backendMode} do receptor local`);
      return;
    }

    if (latest) {
      handleBackendMessage(latest);
    } else if (backendMode === "mqtt") {
      const mqttInput = message.state?.input ?? {};
      const mqttWaitingDetail = mqttInput.subscriptionReady || mqttInput.connected
        ? "Broker e assinatura prontos; aguardando publicação"
        : mqttInput.brokerConnected
          ? mqttInput.lastError ?? "Broker conectado; confirmando assinatura do tópico"
          : mqttInput.lastError ?? "Receptor local ativo; conectando ao broker MQTT";
      updateConnectionUi(
        "waiting",
        mqttWaitingDetail
      );
    } else {
      updateConnectionUi("waiting", "Receptor conectado; aguardando pacotes");
    }
    return;
  }

  if (message.type !== "telemetry" || !message.frame || !message.frontend_values) return;

  const ingestMode = detectedIngestMode(message);
  if (!isExpectedBackendMode(ingestMode)) {
    const expectedLabel = expectedBackendMode() === "mqtt" ? "MQTT" : "serial USB/USB-RF";
    updateConnectionUi("error", `Pacote ${ingestMode} recusado; esperado ${expectedLabel}`);
    return;
  }

  state.lastPacketAt = Date.now();
  updateConnectionUi(
    "online",
    ingestMode === "mock" ? "Recebendo teste simulado do receptor local" : "Recebendo telemetria em tempo real"
  );
  if (ingestMode === "mock") liveTag.textContent = "TESTE";

  if (state.source === "mqtt") {
    const latency = calculateMessageLatency(message);
    setAll("mqtt-latency", latency === null ? "--" : latency);
    if (ingestMode === "mock") setAll("mqtt-status", "TESTE");
  }

  const packetLoss = Number(message.link?.packetLossPercent);
  if (Number.isFinite(packetLoss) && packetLoss >= 0 && packetLoss <= 100) {
    setAll("packet-loss", packetLoss.toFixed(1));
  }

  const rssi = Number(message.frame.rssi_dbm);
  if (Number.isFinite(rssi) && rssi >= -160 && rssi <= 20) setAll("rssi", Math.round(rssi));

  if (state.running) {
    applyFrontendValues(message.frontend_values);
    applyHarnessChannels(message.frame.payload?.harness_voltage);
    if (selectedWireKey) renderWireDetail(selectedWireKey);
  }
}

function updateWireVoltages() {
  let okCount = 0;
  const updatedAt = new Date();

  wireDefinitions.forEach((wire) => {
    const simulatedState = wire.simulationState ?? "ok";
    const disconnected = simulatedState === "disconnected";
    const simulationBase = simulatedState === "fault"
      ? wire.faultBase ?? wire.max + Math.max(wire.swing, 0.5)
      : wire.base;
    const value = disconnected
      ? null
      : fluctuate(simulationBase, wire.swing, wire.decimals);

    const inRange = !disconnected &&
      value != null &&
      value >= wire.min &&
      value <= wire.max;
    const hasVoltageError = !disconnected && !inRange;
    const status = disconnected
      ? "disconnected"
      : hasVoltageError
        ? "fault"
        : "ok";
    const statusLabel = disconnected
      ? "ALTA IMPEDÂNCIA"
      : hasVoltageError
        ? "FORA DA FAIXA"
        : "OK";

    if (inRange) {
      okCount += 1;
    }

    wireRuntime.set(wire.key, {
      value,
      status,
      updatedAt
    });

    setAll(
      `wire-${wire.key}`,
      disconnected ? "--" : value.toFixed(wire.decimals)
    );

    document
      .querySelectorAll(`[data-wire-visual="${wire.key}"]`)
      .forEach((visualWire) => {
        visualWire.classList.remove("wire-no-data");
        visualWire.classList.toggle("wire-error", hasVoltageError);
        visualWire.classList.toggle("wire-disconnected", disconnected);
        visualWire.dataset.wireState = status;
        visualWire.title = `${wire.name} • ${statusLabel}`;
        visualWire.setAttribute(
          "aria-label",
          `${wire.name}. Estado: ${statusLabel}. Abrir dados elétricos.`
        );
      });
  });

  setAll("wire-ok-count", okCount);
  setAll("wire-total-count", wireDefinitions.length);
  refreshHarnessNavigationAlert();

  if (selectedWireKey) {
    renderWireDetail(selectedWireKey);
  }
}

function updateTelemetry() {
  if (!state.running || state.source !== "simulation") return;

  state.speed = Math.max(0, Math.min(245, state.speed + (Math.random() - 0.5) * 4));
  state.rpm = Math.max(900, Math.min(9800, state.rpm + (Math.random() - 0.48) * 190));
  state.torque = Math.max(0, Math.min(260, state.torque + (Math.random() - 0.5) * 12));
  state.power = Math.max(0, Math.min(120, (state.rpm * state.torque) / 9550));
  state.sequence += 1;

  const speed = Math.round(state.speed);
  const rpm = Math.round(state.rpm);
  const torque = Math.round(state.torque);
  const power = Math.round(state.power);
  const gLat = fluctuate(0.74, 0.25, 2);
  const gLong = fluctuate(0.31, 0.2, 2);

  setAll("speed", speed);
  setAll("rpm", rpm.toLocaleString("pt-BR"));
  setAll("torque", torque);
  setAll("power", power);
  setAll("susp-fl", Math.round(fluctuate(42, 8)));
  setAll("susp-fr", Math.round(fluctuate(39, 8)));
  setAll("susp-rl", Math.round(fluctuate(31, 7)));
  setAll("susp-rr", Math.round(fluctuate(34, 7)));
  setAll("temp-fl", Math.round(fluctuate(87, 2)));
  setAll("temp-fr", Math.round(fluctuate(84, 2)));
  setAll("temp-rl", Math.round(fluctuate(81, 2)));
  setAll("temp-rr", Math.round(fluctuate(82, 2)));
  setAll("tire-pressure-fl", fluctuate(2.18, 0.06, 2).toFixed(2));
  setAll("tire-pressure-fr", fluctuate(2.16, 0.06, 2).toFixed(2));
  setAll("tire-pressure-rl", fluctuate(2.09, 0.05, 2).toFixed(2));
  setAll("tire-pressure-rr", fluctuate(2.11, 0.05, 2).toFixed(2));
  setAll("roll", `${fluctuate(1.2, 0.5, 1)}°`);
  setAll("yaw", `${fluctuate(0.8, 0.4, 1)}°`);
  setAll("g-lat", gLat.toFixed(2));
  setAll("g-long", gLong.toFixed(2));

  const wheelSpeed = Math.round(state.speed);
  setAll("wheel-fl", wheelSpeed);
  setAll("wheel-fr", wheelSpeed + 1);
  setAll("wheel-rl", Math.max(0, wheelSpeed - 1));
  setAll("wheel-rr", wheelSpeed);

  const brakeFront = fluctuate(42.8, 9.4, 1);
  const brakeRear = fluctuate(31.4, 7.6, 1);
  setAll("brake-front", brakeFront.toFixed(1));
  setAll("brake-rear", brakeRear.toFixed(1));
  setAll("brake-fl", fluctuate(brakeFront, 1.8, 1).toFixed(1));
  setAll("brake-fr", fluctuate(brakeFront, 1.8, 1).toFixed(1));
  setAll("brake-rl", fluctuate(brakeRear, 1.4, 1).toFixed(1));
  setAll("brake-rr", fluctuate(brakeRear, 1.4, 1).toFixed(1));
  setAll("brake-pedal", Math.round(Math.min(100, brakeFront * 1.1)));
  setAll("regen", Math.round(fluctuate(18, 8)));
  setAll("brake-bias", `${Math.round(fluctuate(58, 3))}`);

  setAll("chassis-lat", fluctuate(0.42, 0.18, 2).toFixed(2));
  setAll("chassis-twist", fluctuate(0.18, 0.08, 2).toFixed(2));
  setAll("delta-chassis", Math.round(fluctuate(38, 14)));
  setAll("strain-peak", Math.round(fluctuate(126, 18)));
  setAll("strain-left", Math.round(fluctuate(82, 14)));
  setAll("strain-right", Math.round(fluctuate(73, 14)));
  setAll("strain-center", Math.round(fluctuate(61, 10)));
  setAll("strain-rear", Math.round(fluctuate(48, 9)));

  setAll("bearing-rms", fluctuate(1.8, 0.4, 1).toFixed(1));
  setAll("bearing-peak", fluctuate(4.6, 0.9, 1).toFixed(1));
  setAll("bearing-temp", Math.round(fluctuate(52, 3)));
  setAll("bearing-frequency", Math.round(fluctuate(184, 18)));
  setAll("bearing-health", Math.round(fluctuate(91, 4)));

  setAll("rssi", Math.round(fluctuate(-61, 7)));
  setAll("packet-loss", fluctuate(0.4, 0.5, 1).toFixed(1));

  setCss("--speed-arc", `${Math.max(90, Math.min(520, speed * 2.05))}`);
  setCss("--g-x", `${50 + Math.max(-34, Math.min(34, gLat * 28))}%`);
  setCss("--g-y", `${50 - Math.max(-34, Math.min(34, gLong * 28))}%`);

  updateWireVoltages();
  evaluateTelemetryNavigationAlerts();
}

setInterval(updateTelemetry, 500);
setInterval(() => {
  if (!state.running) return;
  state.elapsed += 1;
  timer.textContent = formatTime(state.elapsed);
}, 1000);

staleTimer = setInterval(() => {
  if (
    state.source === "simulation"
    || !state.lastPacketAt
    || !["online", "waiting"].includes(state.connectionState)
  ) return;

  const ageMs = Date.now() - state.lastPacketAt;
  if (ageMs > 3000) {
    updateConnectionUi("waiting", `Sem novos pacotes há ${(ageMs / 1000).toFixed(1)} s`);
  }
}, 1000);

pauseButton.addEventListener("click", () => {
  state.running = !state.running;
  pauseButton.classList.toggle("paused", !state.running);
  pauseButton.setAttribute("aria-label", state.running ? "Pausar atualização" : "Retomar atualização");
  showToast(state.running ? "Atualização da tela retomada" : "Atualização da tela pausada");
});

connectionButton.addEventListener("click", openConnectionModal);
compactConnectionButton.addEventListener("click", openConnectionModal);
connectionClose.addEventListener("click", closeConnectionModal);
connectionCancel.addEventListener("click", closeConnectionModal);
dataSourceSelect.addEventListener("change", () => {
  const isInverter = dataSourceSelect.value === "inverter";
  if (isInverter !== connectionFormWasInverter) {
    backendUrlInput.value = isInverter ? state.inverterUrl : state.backendUrl;
    connectionFormWasInverter = isInverter;
  }
  syncConnectionForm();
});

connectionModal.addEventListener("click", (event) => {
  if (event.target === connectionModal) closeConnectionModal();
});

connectionModal.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;

  const focusable = Array.from(
    connectionModal.querySelectorAll("button, select, input, [tabindex]:not([tabindex='-1'])")
  ).filter((element) => !element.disabled && !element.closest("[hidden]"));

  if (focusable.length === 0) return;
  const currentIndex = focusable.indexOf(document.activeElement);
  const nextIndex = event.shiftKey
    ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
    : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);

  if (currentIndex === -1 || nextIndex !== currentIndex + (event.shiftKey ? -1 : 1)) {
    event.preventDefault();
    focusable[nextIndex].focus();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !connectionModal.hidden) closeConnectionModal();
});

const inverterPanel = createInverterPanel({
  setValue: setAll,
  setArc: (rpm) => setCss("--speed-arc", `${90 + Math.min(1, rpm / 10000) * 430}`),
  connection: updateConnectionUi,
  setAlert: setNavigationAlert,
  isRunning: () => state.running,
});

function activateInverterDemo() {
  inverterPanel.stop();
  disconnectTelemetrySocket(true);
  state.source = state.expectedTransport = "inverter_demo";
  state.running = true;
  pauseButton.classList.remove("paused");
  pauseButton.setAttribute("aria-label", "Pausar atualização");
  prepareExternalTelemetry();
  inverterPanel.startDemo();
  showPage("dynamics");
  document.title = "Bancada virtual do inversor · AM07";
  if (location.hash !== "#inversor-demo") history.replaceState(null, "", "#inversor-demo");
}

document.getElementById("startInverterDemo").addEventListener("click", activateInverterDemo);

connectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const sourceId = dataSourceSelect.value;
  const source = sourceDefinitions[sourceId] ?? sourceDefinitions.simulation;
  if (sourceId === "inverter_demo") {
    closeConnectionModal();
    activateInverterDemo();
    return;
  }
  let inverterEndpoint;
  let inverterKey;

  if (sourceId === "inverter") {
    try {
      const endpoint = new URL(backendUrlInput.value.trim());
      if (
        endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/ws"
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      ) throw new Error("Endereço inválido");
      inverterEndpoint = endpoint.href;
      inverterKey = document.getElementById("inverterKey").value;
    } catch {
      showToast("Para o inversor, use o endereço local exibido no receptor, como ws://127.0.0.1:8787/ws");
      return;
    }
  }

  inverterPanel.stop();
  disconnectTelemetrySocket(true);
  document.title = dashboardTitle;
  if (["#inversor-demo", "#inversor-usb"].includes(location.hash)) history.replaceState(null, "", location.href.split("#")[0]);
  state.source = sourceId;
  state.expectedTransport = sourceId;

  if (sourceId === "simulation") {
    restoreSimulationDiagnostics();
    updateConnectionUi("simulation", "Dados demonstrativos");
    updateTelemetry();
    showToast("Simulação local selecionada");
  } else if (sourceId === "inverter") {
    state.inverterUrl = inverterEndpoint;
    prepareExternalTelemetry();
    inverterPanel.start(inverterEndpoint, inverterKey);
    showPage("dynamics");
  } else {
    state.backendUrl = backendUrlInput.value.trim();
    prepareExternalTelemetry();
    updateConnectionUi("connecting", `Preparando ${source.label.toLowerCase()}`);
    connectTelemetryBackend();
    showToast(`${source.label}: conectando ao receptor local`);
  }

  closeConnectionModal();
});

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove("show"), 3200);
}

initializeNavigationAlerts();
renderHarnessWires();
restoreSimulationDiagnostics();
updateConnectionUi("simulation", "Dados demonstrativos");
updateTelemetry();
if (location.hash === "#inversor-demo") {
  activateInverterDemo();
} else if (location.hash === "#inversor-usb") {
  showPage("dynamics");
  openConnectionModal(undefined, "inverter");
}
