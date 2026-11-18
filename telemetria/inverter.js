function createInverterPanel({ setValue, setArc, connection, setAlert, isRunning }) {
  const get = (id) => document.getElementById(id);
  const panel = get("inverterPanel");
  const port = get("inverterPort");
  const refresh = get("inverterRefresh");
  const localPage = get("inverterLocalPage");
  const status = get("inverterStatus");
  const stateBadge = get("inverterState");
  const search = get("inverterSearch");
  const parameter = get("inverterParam");
  const parameterValue = get("inverterParamValue");
  const help = get("inverterParamHelp");
  const channels = get("inverterChannels");
  const plots = get("inverterPlots");
  const scopeStatus = get("inverterScopeStatus");
  const scopeInterval = get("inverterScopeInterval");
  const liveScopeButton = get("inverterLiveScope");
  const scopeCsv = get("inverterScopeCsv");
  const demoForm = get("inverterDemoForm");
  const demoMode = get("inverterDemoMode");
  const voltageForm = get("inverterVoltageForm");
  const voltageSlider = get("inverterVoltageSlider");
  const voltageApply = get("inverterVoltageApply");
  const voltageStatus = get("inverterVoltageStatus");
  const torqueControl = get("inverterTorqueControl");
  const torqueInput = get("inverterTorqueInput");
  const torqueSlider = get("inverterTorqueSlider");
  const torqueModeButton = get("inverterTorqueMode");
  const torqueStatus = get("inverterTorqueStatus");
  const fieldPanel = get("inverterFieldWeakening");
  const fieldPlots = get("inverterFieldPlots");
  const fieldHistory = [];
  const commandButtons = [...get("inverterCommands").querySelectorAll("button")];
  const format = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
  const fineFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 });
  const scopeUnits = {
    Id: "A", Iq: "A", Iu: "A", Iv: "A", Iw: "A", Vd: "V", Vq: "V", vbus: "V",
    theta_elec: "rad elét.", theta_est: "rad elét.", theta_err: "rad elét.",
    omega_elec: "rad/s elét.", res_w_lpf: "rad/s elét.", res_sin: "ADC", res_cos: "ADC",
  };
  const scopeViewer = createInverterScopeViewer({
    units: scopeUnits,
    captureNow: () => get("inverterScopeForm").requestSubmit(),
  });
  const miniPlots = new Map();
  let serial = null;
  let available = false;
  let connectedPort = null;
  let catalog = [];
  let deviceCommands = new Set();
  let pending = null;
  let working = false;
  let commandPending = null;
  let stopping = false;
  let displayedParameter = "";
  let motorState = "";
  let motorFault = false;
  let voltageLimit = null;
  let voltageDraft = null;
  let torqueReference = null;
  let torqueDraft = null;
  let torqueQueued = false;
  let liveScope = null;
  let scopeTimer = null;
  let lastCapture = null;
  let demo = null;
  let previousScopeSettings = null;

  function selectOptions(select, placeholder, entries) {
    const selected = select.value;
    select.replaceChildren(new Option(placeholder, ""), ...entries.map(([label, value]) => new Option(label, value)));
    if (entries.some(([, value]) => value === selected)) select.value = selected;
  }

  function selectedParameter() {
    return catalog.find((item) => item.name === parameter.value);
  }

  function commandEnabled(action) {
    if (!connectedPort) return false;
    if (demo) return !working;
    if (!deviceCommands.has(action) || stopping) return false;
    if (action === "stop") return true;
    if (working || commandPending) return false;
    return action === "clear_fault" ? motorState === "FAULT" : motorState === "IDLE" && !motorFault;
  }

  function syncVoltageControls(busy) {
    voltageForm.hidden = !connectedPort || Boolean(demo);
    if (voltageForm.hidden) return;
    const help = get("inverterVoltageHelp");
    const allowedState = motorState === "IDLE" || (motorState === "RUN" && !voltageLimit?.needsIdle);
    const max = voltageLimit?.maxVolts ?? 0;
    voltageSlider.max = String(max);
    voltageSlider.value = String(Math.min(voltageDraft ?? voltageLimit?.volts ?? 0, max));
    voltageSlider.disabled = !voltageLimit || max <= 0 || !allowedState || motorFault || busy;
    voltageApply.disabled = voltageSlider.disabled || Math.abs(voltageSlider.valueAsNumber - voltageLimit.volts) < 1e-6;
    get("inverterVoltageSelected").value = voltageLimit ? `${format.format(voltageSlider.valueAsNumber)} V` : "--";
    get("inverterVoltageApplied").textContent = voltageLimit ? `${format.format(voltageLimit.volts)} V` : "--";
    if (voltageLimit === undefined) {
      help.textContent = "Reinicie o receptor local para habilitar o ajuste.";
    } else if (!voltageLimit) {
      help.textContent = "A MCU não disponibilizou o limite de tensão.";
    } else if (!allowedState || motorFault) {
      help.textContent = voltageLimit.needsIdle ? "Ajuste disponível em IDLE sem falha ativa." : "Ajuste disponível em IDLE ou RUN sem falha ativa.";
    } else {
      const busDetail = voltageLimit.usesOverride ? " Valor calculado com o barramento configurado no firmware." : "";
      help.textContent = `Faixa de 0 a ${format.format(max)} V, conforme o limite lido ao conectar.${busDetail}`;
    }
  }

  function syncTorqueControls(busy) {
    torqueControl.hidden = !connectedPort || Boolean(demo);
    if (torqueControl.hidden) return;
    const reference = torqueReference;
    const mode = reference?.mode;
    const max = reference?.maxNm ?? 0;
    const inBenchState = (motorState === "IDLE" || motorState === "RUN") && !motorFault;
    const draft = torqueDraft ?? reference?.nm;
    get("inverterTorqueModeValue").value = mode === 0 ? "Torque" : mode === 1 ? "Velocidade" : "--";
    torqueModeButton.hidden = mode !== 1;
    torqueModeButton.disabled = busy || !reference?.canSelectMode || !inBenchState
      || (reference.modeNeedsIdle && motorState !== "IDLE");
    torqueInput.min = torqueSlider.min = String(-max);
    torqueInput.max = torqueSlider.max = String(max);
    torqueInput.disabled = torqueSlider.disabled = !reference?.canWrite || max <= 0 || mode !== 0 || !inBenchState || busy;
    if (document.activeElement !== torqueInput) torqueInput.value = Number.isFinite(draft) ? String(draft) : "";
    torqueSlider.value = String(Number.isFinite(draft) ? Math.max(-max, Math.min(max, draft)) : 0);
    get("inverterTorqueApplied").textContent = reference ? `${fineFormat.format(reference.nm)} Nm` : "--";
    get("inverterTorqueIq").textContent = reference ? `${fineFormat.format(reference.iq)} A` : "--";
    const help = get("inverterTorqueHelp");
    if (reference === undefined) help.textContent = "Reinicie o receptor para habilitar o ajuste.";
    else if (!reference?.canWrite) help.textContent = "A MCU não disponibilizou ajuste de referência de torque.";
    else if (!inBenchState) help.textContent = "O estado atual da MCU bloqueia o ajuste.";
    else if (mode !== 0) help.textContent = "Selecione o modo torque para comandar Iq.";
    else if (motorState === "IDLE") help.textContent = "A referência escolhida será enviada automaticamente quando a MCU entrar em RUN.";
    else help.textContent = `Envio ao soltar o slider. Faixa de ±${fineFormat.format(max)} Nm, limitada a ${fineFormat.format(reference.maxIq)} A.`;
  }

  function clearTorqueDraft() {
    torqueDraft = null;
    torqueQueued = false;
    torqueStatus.textContent = "";
  }

  function applyQueuedTorque() {
    if (!torqueQueued || torqueControl.hidden || torqueSlider.disabled || pending || motorState !== "RUN") return;
    const nm = torqueDraft;
    torqueQueued = false;
    if (!Number.isFinite(nm) || Math.abs(nm) > torqueReference.maxNm) {
      torqueStatus.textContent = "Informe uma referência dentro da faixa atual da MCU.";
      return;
    }
    if (Math.abs(nm - torqueReference.nm) < 1e-8) {
      clearTorqueDraft();
      syncTorqueControls(false);
      return;
    }
    torqueStatus.textContent = "Enviando referência à MCU…";
    void perform("torque_reference", { nm }, (confirmed) => {
      torqueReference = confirmed;
      if (torqueDraft !== nm) return;
      clearTorqueDraft();
      torqueStatus.textContent = `Referência lida na MCU: ${fineFormat.format(confirmed.nm)} Nm (${fineFormat.format(confirmed.iq)} A).`;
    }, torqueStatus);
  }

  function paintFieldWeakening(field) {
    fieldPanel.hidden = !connectedPort || Boolean(demo);
    if (fieldPanel.hidden) return;
    const fieldStatus = get("inverterFieldStatus");
    if (field === undefined) fieldStatus.textContent = "Reinicie o receptor para visualizar os sinais do FW.";
    else if (!field) fieldStatus.textContent = "A MCU não disponibilizou sinais do FW.";
    else if (field.enabled === false) fieldStatus.textContent = "Desativado no firmware";
    else if (motorState !== "RUN") fieldStatus.textContent = "Aguardando RUN";
    else if (field.observerActive) fieldStatus.textContent = "Inibido pelo modo sensorless";
    else if (field.idAmps < -0.001) fieldStatus.textContent = "Em atuação";
    else if (field.enabled && Number.isFinite(field.idAmps)) fieldStatus.textContent = "Habilitado · sem atuação";
    else fieldStatus.textContent = "Estado do regulador indisponível";
    [["inverterFieldId", field?.idAmps], ["inverterFieldVoltage", field?.requestedVolts],
      ["inverterFieldTarget", field?.targetVolts]].forEach(([id, value]) => {
      get(id).textContent = Number.isFinite(value) ? fineFormat.format(value) : "--";
    });
    if (!field) return;
    fieldHistory.push(field);
    if (fieldHistory.length > 60) fieldHistory.shift();
    const trace = (name) => fieldHistory.map((sample) => sample[name]);
    fieldPlots.replaceChildren(
      plotInverterSignal("Id do regulador", "A", trace("idAmps"), fineFormat),
      plotInverterSignal("Tensão solicitada e limiar do FW", "V", trace("requestedVolts"), format, trace("targetVolts")),
    );
    get("inverterFieldLegend").hidden = !fieldHistory.some(sample => Number.isFinite(sample.targetVolts));
  }

  function syncControls() {
    const selected = selectedParameter();
    const editable = demo && connectedPort && selected && !selected.readOnly && (!selected.needsIdle || motorState === "IDLE");
    const scopeReady = Boolean(connectedPort) && channels.querySelector("input") !== null;
    const busy = working || Boolean(commandPending);
    port.disabled = !serial || working || Boolean(connectedPort) || port.options.length < 2;
    refresh.disabled = !serial || working || Boolean(connectedPort);
    get("inverterConnect").disabled = port.disabled || !port.value;
    get("inverterDisconnect").disabled = !connectedPort || busy;
    search.disabled = parameter.disabled = !connectedPort || busy;
    get("inverterRead").disabled = !connectedPort || !selected || busy;
    parameterValue.disabled = !editable || working;
    get("inverterWrite").disabled = !editable || working;
    channels.disabled = get("inverterDecimation").disabled = get("inverterCapture").disabled = !scopeReady || busy;
    liveScopeButton.disabled = !scopeReady || (!liveScope && busy);
    scopeInterval.disabled = liveScopeButton.disabled || Boolean(liveScope);
    scopeCsv.disabled = !lastCapture;
    scopeViewer.setCaptureEnabled(scopeReady && !busy);
    demoForm.querySelectorAll("input, select, button").forEach((element) => { element.disabled = working; });
    syncDemoReferenceFields();
    syncVoltageControls(busy);
    syncTorqueControls(busy);
    commandButtons.forEach((button) => { button.disabled = !commandEnabled(button.dataset.inverterCommand); });
    applyQueuedTorque();
  }

  function setReading(name, value, formatter = format) {
    setValue(name, Number.isFinite(value) ? formatter.format(value) : "--");
  }

  function paintReadings(snapshot = {}, updateValues = true) {
    const previousState = motorState;
    motorState = snapshot.state ?? "";
    motorFault = Boolean(snapshot.fault) || motorState === "FAULT";
    voltageLimit = snapshot.voltageLimit;
    torqueReference = snapshot.torqueReference;
    if (motorFault || (motorState !== "RUN" && previousState === "RUN")
      || (torqueQueued && torqueReference?.mode !== 0)) clearTorqueDraft();
    stateBadge.textContent = motorState || "SEM CONEXÃO";
    stateBadge.classList.toggle("bad", motorFault);
    stateBadge.classList.toggle("good", motorState === "RUN");
    get("inverterFault").textContent = snapshot.faultReason || (snapshot.fault === 0 ? "Nenhuma" : "--");
    get("inverterWarning").textContent = snapshot.warningReason || (snapshot.warning === 0 ? "Nenhum" : "--");
    if (updateValues) {
      setReading("inverter-vbus", snapshot.vbus);
      setReading("rpm", Number.isFinite(snapshot.rpm) ? Math.round(snapshot.rpm) : null);
      setArc(Number.isFinite(snapshot.rpm) ? Math.abs(snapshot.rpm) : 0);
      if (demo) {
        setReading("torque", snapshot.torque, fineFormat);
        setReading("power", snapshot.power, fineFormat);
        setReading("inverter-id", snapshot.id);
        setReading("inverter-iq", snapshot.iq);
      }
      paintFieldWeakening(snapshot.fieldWeakening);
    }
    setAlert("dynamics", motorFault, snapshot.faultReason || "falha informada pelo inversor");
    syncControls();
  }

  function showParameter(resetValue = false) {
    const selected = selectedParameter();
    if (resetValue || displayedParameter !== parameter.value) parameterValue.value = "";
    displayedParameter = parameter.value;
    help.textContent = selected
      ? [
          selected.type, selected.unit, selected.readOnly ? "Somente leitura" : selected.needsIdle ? "Escrita em IDLE" : "Leitura e escrita",
          selected.description,
        ].filter(Boolean).join(" · ")
      : demo ? "Selecione um parâmetro do modelo simulado." : "Selecione um parâmetro do catálogo enviado pelo MCU.";
    syncControls();
  }

  function filterCatalog() {
    const query = search.value.trim().toLocaleLowerCase("pt-BR");
    selectOptions(parameter, "Selecione um parâmetro", catalog
      .filter((item) => `${item.name} ${item.description}`.toLocaleLowerCase("pt-BR").includes(query))
      .map((item) => [item.unit ? `${item.name} · ${item.unit}` : item.name, item.name]));
    showParameter();
  }

  function clearDevice() {
    stopLiveScope();
    scopeViewer.clear();
    connectedPort = null;
    voltageDraft = null;
    voltageStatus.textContent = "";
    clearTorqueDraft();
    fieldHistory.length = 0;
    fieldPlots.replaceChildren();
    get("inverterFieldLegend").hidden = true;
    catalog = [];
    deviceCommands.clear();
    search.value = "";
    filterCatalog();
    showParameter(true);
    channels.querySelectorAll("label").forEach((item) => item.remove());
    scopeStatus.textContent = "";
    lastCapture = null;
    miniPlots.clear();
    plots.replaceChildren();
    setReading("inverter-id");
    setReading("inverter-iq");
    paintReadings();
  }

  function request(op, fields = {}) {
    if (demo) {
      const model = demo;
      return Promise.resolve().then(() => model.request(op, fields));
    }
    if (!serial || pending) return Promise.reject(new Error("Porta serial indisponível."));
    const session = serial;
    const actions = {
      read: () => session.read(fields.name),
      poll: session.poll,
      scope: () => session.scope(fields),
      voltage_limit: () => session.setVoltageLimit(fields.volts),
      torque_mode: session.selectTorqueMode,
      torque_reference: () => session.setTorqueReference(fields.nm),
    };
    if (!Object.hasOwn(actions, op)) return Promise.reject(new Error("Operação indisponível no inversor."));
    const operation = actions[op]();
    pending = operation;
    return operation.finally(() => { if (pending === operation) pending = null; });
  }

  async function perform(op, fields, onResult, errorTarget = status) {
    if (working || commandPending || !available) return;
    const session = demo ?? serial;
    working = true;
    syncControls();
    try {
      if (pending) await pending.catch(() => {});
      if ((demo ?? serial) !== session || !connectedPort || commandPending) return;
      const result = await request(op, fields);
      if ((demo ?? serial) === session) onResult(result);
    } catch (error) {
      if ((demo ?? serial) === session) errorTarget.textContent = error.message;
    } finally {
      if ((demo ?? serial) === session) {
        working = false;
        syncControls();
      }
    }
  }

  function showPanel() {
    panel.hidden = false;
    get("dynamicsRoadSpeed").hidden = true;
    get("dynamicsMotorRpm").hidden = false;
  }

  function setConnectionStatus(phase, message) {
    status.textContent = message;
    connection(phase, message);
  }

  async function refreshPorts(
    message = "Selecione a porta COM e clique em Conectar MCU.",
    phase = "waiting",
  ) {
    if (!serial || working || connectedPort) return;
    const session = serial;
    working = true;
    syncControls();
    if (phase === "waiting") setConnectionStatus("connecting", "Buscando portas seriais no Windows…");
    try {
      const { ports, preferred } = await session.ports();
      if (serial !== session) return;
      selectOptions(port, "Selecione uma porta", ports.map(({ port, description }) => [
        description.includes(port) ? description : `${port} · ${description}`, port,
      ]));
      if (!port.value && preferred) port.value = preferred;
      if (ports.length || phase !== "waiting") setConnectionStatus(phase, message);
      else setConnectionStatus("error", "Nenhuma porta do inversor encontrada. Conecte o XDS100v2 e atualize a lista.");
    } catch (error) {
      if (serial !== session) return;
      selectOptions(port, "Selecione uma porta", []);
      setConnectionStatus("error", error.message);
    } finally {
      if (serial === session) {
        working = false;
        syncControls();
      }
    }
  }

  function start(message, phase) {
    setBenchAppearance("usb");
    showPanel();
    get("inverterCommandDetails").open = get("inverterScopeDetails").open = true;
    available = location.origin === localPage.origin;
    serial = available ? createInverterSerial() : null;
    localPage.hidden = available;
    if (available) refreshPorts(message, phase);
    else setConnectionStatus("offline", "Inicie Abrir_Telemetria_Inversor.bat no PC da MCU e abra a telemetria local.");
    syncControls();
  }

  async function resetSerial(session, phase, message) {
    working = true;
    clearDevice();
    setConnectionStatus(phase, message);
    try {
      await session.close();
    } catch (error) {
      if (phase === "offline") {
        phase = "error";
        message = error.message;
      } else {
        console.error(error);
      }
    }
    if (serial !== session) return;
    working = false;
    start(message, phase);
  }

  function stop() {
    const previous = serial;
    serial = null;
    available = working = false;
    pending = null;
    commandPending = null;
    stopping = false;
    previous?.close().catch(console.error);
    if (panel.hidden) return;
    clearDevice();
    if (demo) {
      demo = null;
      Object.assign(get("inverterDecimation"), previousScopeSettings.decimation);
      get("inverterScopeDetails").open = previousScopeSettings.scopeOpen;
      get("inverterCommandDetails").open = previousScopeSettings.commandsOpen;
      previousScopeSettings = null;
    }
    setBenchAppearance();
    selectOptions(port, "Selecione uma porta", []);
    panel.hidden = get("dynamicsMotorRpm").hidden = true;
    get("dynamicsRoadSpeed").hidden = false;
  }

  function populateChannels(names) {
    names.forEach((name) => {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = name;
      checkbox.checked = ["Id", "Iq", "Iu", "omega_elec"].includes(name);
      label.append(checkbox, name);
      channels.append(label);
    });
  }

  function loadDevice(result) {
    clearDevice();
    connectedPort = result.port;
    catalog = result.parameters;
    deviceCommands = new Set(result.commands ?? []);
    filterCatalog();
    populateChannels(result.channels);
    paintReadings(result.snapshot);
  }

  function setBenchAppearance(mode) {
    const enabled = Boolean(mode);
    const simulated = mode === "demo";
    get("dynamics").classList.toggle("inverter-bench", enabled);
    get("inverterBenchControls").hidden = get("inverterDemoCurrents").hidden = !enabled;
    demoForm.hidden = get("inverterInjectFault").hidden = !simulated;
    get("inverterSerialToolbar").hidden = simulated;
    const parameterDetails = get("inverterParamDetails");
    const scopeDetails = get("inverterScopeDetails");
    const commandDetails = get("inverterCommandDetails");
    if (enabled) {
      parameterDetails.before(scopeDetails);
      get("inverterBenchControls").append(commandDetails);
    } else {
      parameterDetails.after(scopeDetails);
      panel.append(commandDetails);
    }
    get("inverterPanelMode").textContent = simulated ? "SIMULAÇÃO LOCAL • F28379D" : "MCU REAL • USB SERIAL";
    get("inverterRead").textContent = simulated ? "Ler parâmetro" : "Ler do MCU";
    get("inverterWrite").textContent = simulated ? "Aplicar parâmetro" : "Gravar no MCU";
    get("inverterTorqueLabel").textContent = simulated ? "TORQUE SIMULADO" : "TORQUE";
    get("inverterPowerLabel").textContent = simulated ? "POTÊNCIA SIMULADA" : "POTÊNCIA";
    get("startInverterDemo").textContent = simulated ? "Reiniciar simulação" : "Simular inversor";
  }

  function syncDemoReferenceFields() {
    const speedMode = demoMode.value === "1";
    get("inverterDemoRpmField").hidden = !speedMode;
    get("inverterDemoTorqueField").hidden = speedMode;
    get("inverterDemoRpm").disabled = working || !speedMode;
    get("inverterDemoTorque").disabled = working || speedMode;
    get("inverterDemoRpmSlider").disabled = working || !speedMode;
    get("inverterDemoTorqueSlider").disabled = working || speedMode;
  }

  function showReferences(references) {
    demoMode.value = references.mode;
    get("inverterDemoRpm").value = references.rpm;
    get("inverterDemoTorque").value = references.torque;
    get("inverterDemoRpmSlider").value = references.rpm;
    get("inverterDemoTorqueSlider").value = references.torque;
    get("inverterDemoCurrent").value = references.currentLimit;
    get("inverterDemoLoad").value = references.load;
    syncDemoReferenceFields();
  }

  function startDemo() {
    demo = createInverterDemo();
    localPage.hidden = true;
    available = true;
    const decimation = get("inverterDecimation");
    previousScopeSettings = {
      decimation: { max: decimation.max, value: decimation.value },
      scopeOpen: get("inverterScopeDetails").open,
      commandsOpen: get("inverterCommandDetails").open,
    };
    decimation.max = "1000";
    decimation.value = "10";
    get("inverterScopeDetails").open = true;
    get("inverterCommandDetails").open = true;
    setBenchAppearance("demo");
    showPanel();
    const result = demo.request("connect");
    loadDevice(result);
    showReferences(result.snapshot.references);
    status.textContent = "Bancada virtual ligada. Ajuste as referências e acompanhe a resposta nos gráficos.";
    connection("simulation", status.textContent);
    beginLiveScope();
  }

  demoMode.addEventListener("change", syncDemoReferenceFields);
  voltageSlider.addEventListener("input", () => {
    voltageDraft = voltageSlider.valueAsNumber;
    voltageStatus.textContent = "";
    syncControls();
  });
  voltageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (voltageApply.disabled || voltageForm.hidden) return;
    const volts = voltageSlider.valueAsNumber;
    perform("voltage_limit", { volts }, (confirmed) => {
      voltageLimit = confirmed;
      voltageDraft = null;
      voltageStatus.textContent = `Limite confirmado pela MCU em ${format.format(confirmed.volts)} V.`;
    }, voltageStatus);
  });
  [torqueInput, torqueSlider].forEach((input) => {
    input.addEventListener("input", () => {
      torqueDraft = input.valueAsNumber;
      torqueQueued = false;
      torqueStatus.textContent = "";
      syncControls();
    });
    input.addEventListener("change", () => {
      if (input.disabled || torqueControl.hidden) return;
      torqueDraft = input.valueAsNumber;
      torqueQueued = Number.isFinite(torqueDraft) && Math.abs(torqueDraft) <= torqueReference.maxNm;
      if (!torqueQueued) torqueStatus.textContent = "Informe uma referência dentro da faixa atual da MCU.";
      else if (motorState === "IDLE") torqueStatus.textContent = "Referência aguardando RUN.";
      syncControls();
    });
  });
  torqueModeButton.addEventListener("click", () => {
    if (torqueModeButton.disabled || torqueControl.hidden) return;
    if (motorState === "RUN" && !window.confirm(`Mudar o controle da MCU em ${connectedPort} para modo torque?`)) return;
    perform("torque_mode", {}, (confirmed) => {
      torqueReference = confirmed;
      torqueStatus.textContent = "Modo torque confirmado pela MCU.";
    }, torqueStatus);
  });
  ["Rpm", "Torque"].forEach((reference) => {
    const input = get(`inverterDemo${reference}`);
    const slider = get(`inverterDemo${reference}Slider`);
    slider.addEventListener("input", () => { input.value = slider.value; });
    input.addEventListener("input", () => {
      if (Number.isFinite(input.valueAsNumber)) slider.value = input.value;
    });
  });
  demoForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!demo) return;
    perform("references", {
      mode: Number(demoMode.value),
      rpm: get("inverterDemoRpm").valueAsNumber,
      torque: get("inverterDemoTorque").valueAsNumber,
      currentLimit: get("inverterDemoCurrent").valueAsNumber,
      load: get("inverterDemoLoad").valueAsNumber,
    }, (snapshot) => {
      showParameter(true);
      showReferences(snapshot.references);
      paintReadings(snapshot);
      status.textContent = "Referências aplicadas à bancada virtual.";
    });
  });

  refresh.addEventListener("click", () => refreshPorts());
  port.addEventListener("change", syncControls);
  window.addEventListener("pagehide", () => {
    serial?.close(true).catch(() => {});
  });

  get("inverterConnect").addEventListener("click", async () => {
    if (!serial || working || connectedPort || !port.value) return;
    const session = serial;
    working = true;
    syncControls();
    setConnectionStatus("connecting", `Abrindo ${port.value} e lendo a MCU…`);
    try {
      const result = await session.connect(port.value);
      if (serial !== session) return;
      loadDevice(result);
      working = false;
      status.textContent = `${connectedPort} · ${catalog.length} parâmetros · MCU real`;
      if (!result.channels.length || !deviceCommands.size) {
        status.textContent += " · Reinicie o receptor para habilitar os comandos e os gráficos.";
      }
      connection("online", `Inversor conectado em ${connectedPort}`);
      syncControls();
      if (result.channels.length) beginLiveScope();
    } catch (error) {
      if (serial !== session) return;
      await resetSerial(session, "error", error.message);
    }
  });
  get("inverterDisconnect").addEventListener("click", () => {
    if (!serial || !connectedPort || working || commandPending) return;
    resetSerial(serial, "offline", "MCU desconectada. Clique em Conectar MCU para conectar novamente.");
  });
  search.addEventListener("input", filterCatalog);
  parameter.addEventListener("change", () => showParameter(true));
  get("inverterRead").addEventListener("click", () => {
    perform("read", { name: parameter.value }, (result) => {
      parameterValue.value = result.value ?? "";
      status.textContent = `${result.name} lido ${demo ? "do simulador" : "do MCU"}.`;
    });
  });
  get("inverterParamForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = selectedParameter();
    const value = parameterValue.valueAsNumber;
    if (!demo || !selected || parameterValue.disabled || !Number.isFinite(value)) return;
    perform("write", { name: selected.name, value }, (result) => {
      parameterValue.value = result.value ?? "";
      showReferences(result.references);
      status.textContent = `${result.name} · valor lido após a escrita: ${result.value ?? "indisponível"} ${selected.unit}`;
    });
  });
  async function sendMotorCommand(action, label) {
    const session = serial;
    if (action === "stop") clearTorqueDraft();
    const operation = session.command(action);
    commandPending = operation;
    stopping = action === "stop";
    syncControls();
    try {
      const { state } = await operation;
      if (serial === session && commandPending === operation) {
        status.textContent = `${label} enviado · estado retornado: ${state}.`;
      }
    } catch (error) {
      if (serial === session && commandPending === operation) status.textContent = error.message;
    } finally {
      if (commandPending === operation) {
        commandPending = null;
        stopping = false;
        syncControls();
      }
    }
  }

  commandButtons.forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.inverterCommand;
    if (!commandEnabled(action)) return;
    if (demo) {
      perform("command", { action }, (snapshot) => {
        paintReadings(snapshot);
        status.textContent = `${button.textContent} · estado retornado: ${snapshot.state}.`;
      });
      return;
    }
    if (action !== "stop") {
      const movement = action === "run" || action === "align" ? " O motor pode se movimentar." : "";
      if (!window.confirm(`Executar “${button.textContent}” na MCU real em ${connectedPort}?${movement}`)) return;
    }
    void sendMotorCommand(action, button.textContent);
  }));
  function getScopeConfig() {
    const selected = [...channels.querySelectorAll("input:checked")].map((input) => input.value);
    if (!selected.length) {
      scopeStatus.textContent = "Selecione pelo menos um sinal.";
      return null;
    }
    const decimation = get("inverterDecimation");
    if (!decimation.reportValidity()) return null;
    return { channels: selected, decimation: decimation.valueAsNumber };
  }

  function renderCapture(capture, decimation) {
    if (capture.waitMs) {
      scopeStatus.textContent = liveScope
        ? "Aguardando amostras com a nova decimação…"
        : `Aguardando amostras com a nova decimação. Capture novamente após ${format.format(capture.waitMs / 1000)} s.`;
      return;
    }
    lastCapture = capture;
    const changed = [...miniPlots.keys()].join("\n") !== capture.names.join("\n");
    if (changed) {
      const buttons = capture.names.map((name) => {
        if (miniPlots.has(name)) return [name, miniPlots.get(name)];
        const button = document.createElement("button");
        button.type = "button";
        button.className = "inverter-plot-button";
        button.setAttribute("aria-label", `Ampliar sinal ${name}`);
        button.append(document.createElement("figure"));
        const hint = document.createElement("span");
        hint.className = "inverter-plot-expand";
        hint.setAttribute("aria-hidden", "true");
        hint.textContent = "Ampliar ↗";
        button.append(hint);
        button.addEventListener("click", () => scopeViewer.open(name, button));
        return [name, button];
      });
      miniPlots.clear();
      buttons.forEach(([name, button]) => miniPlots.set(name, button));
      plots.replaceChildren(...miniPlots.values());
    }
    capture.names.forEach((name, index) => {
      miniPlots.get(name).firstElementChild.replaceWith(plotInverterSignal(name, scopeUnits[name], capture.data[index], format));
      if (!demo && (name === "Id" || name === "Iq")) {
        setReading(`inverter-${name.toLowerCase()}`, capture.data[index].at(-1));
      }
    });
    scopeViewer.update(capture, decimation);
    const milliseconds = (capture.n_samples - 1) * (capture.sample_ms ?? decimation / 10);
    scopeStatus.textContent = `${capture.n_samples} amostras por sinal · decimação ${decimation} · ${format.format(milliseconds)} ms${liveScope ? " · ao vivo" : ""}`;
    syncControls();
  }

  function stopLiveScope() {
    liveScope = null;
    clearTimeout(scopeTimer);
    liveScopeButton.textContent = "Iniciar ao vivo";
    liveScopeButton.setAttribute("aria-pressed", "false");
  }

  function scheduleScope(run, delay) {
    scopeTimer = setTimeout(async () => {
      if (liveScope !== run || !connectedPort) return;
      const config = getScopeConfig();
      if (!config) {
        stopLiveScope();
        syncControls();
        return;
      }
      if (!pending && !working && !commandPending && isRunning()) {
        try {
          const capture = await request("scope", config);
          if (liveScope === run && isRunning()) renderCapture(capture, config.decimation);
        } catch (error) {
          if (liveScope !== run) return;
          scopeStatus.textContent = error.message;
        }
      }
      if (liveScope === run) scheduleScope(run, run.interval);
    }, delay);
  }

  function beginLiveScope() {
    if (!scopeInterval.reportValidity() || !getScopeConfig()) return;
    liveScope = { interval: scopeInterval.valueAsNumber };
    liveScopeButton.textContent = "Parar captura ao vivo";
    liveScopeButton.setAttribute("aria-pressed", "true");
    scopeStatus.textContent = "Aguardando a primeira captura…";
    syncControls();
    scheduleScope(liveScope, 0);
  }

  liveScopeButton.addEventListener("click", () => {
    if (liveScope) {
      stopLiveScope();
      scopeStatus.textContent = "Captura ao vivo encerrada.";
      syncControls();
    } else {
      beginLiveScope();
    }
  });

  get("inverterScopeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const config = getScopeConfig();
    if (config) perform("scope", config, (capture) => renderCapture(capture, config.decimation), scopeStatus);
  });

  scopeCsv.addEventListener("click", () => {
    if (!lastCapture) return;
    const { names, data, n_samples } = lastCapture;
    const rows = Array.from({ length: n_samples }, (_, index) => [
      index, ...data.map((signal) => signal[index] ?? ""),
    ].join(","));
    const header = ["sample", ...names].join(",");
    const csv = [header, ...rows].join("\n") + "\n";
    const url = URL.createObjectURL(new Blob([csv], {
      type: "text/csv;charset=utf-8",
    }));
    const link = document.createElement("a");
    link.href = url;
    link.download = demo ? "AM07-inversor-simulacao.csv" : "AM07-inversor-captura.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  async function poll() {
    if (!connectedPort || pending || working || commandPending) return;
    const session = demo ?? serial;
    try {
      const snapshot = await request("poll");
      if (connectedPort && (demo ?? serial) === session) paintReadings(snapshot, isRunning());
    } catch (error) {
      if (!connectedPort || (demo ?? serial) !== session) return;
      if (demo) {
        status.textContent = error.message;
        return;
      }
      await resetSerial(session, "error", error.message);
    }
  }
  setInterval(() => { if (demo) poll(); }, 250);
  setInterval(() => { if (!demo) poll(); }, 1000);

  return { start, startDemo, stop };
}

function plotInverterSignal(name, unit, samples, format, reference = []) {
  const figure = document.createElement("figure");
  const caption = document.createElement("figcaption");
  caption.textContent = unit ? `${name} (${unit})` : name;
  const scale = document.createElement("small");
  scale.className = "inverter-plot-scale";
  figure.append(caption);
  const numeric = [...samples, ...reference].filter(Number.isFinite);
  if (!numeric.length) {
    scale.textContent = "Sem amostras válidas";
    figure.append(scale);
    return figure;
  }
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 240 80");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Curva de ${name} por amostra`);
  const grid = document.createElementNS(svg.namespaceURI, "path");
  grid.setAttribute("class", "inverter-grid");
  grid.setAttribute("d", "M0 8H240 M0 40H240 M0 72H240");
  function trace(values) {
    const line = document.createElementNS(svg.namespaceURI, "path");
    let penDown = false;
    line.setAttribute("d", values.map((value, index) => {
      if (!Number.isFinite(value)) {
        penDown = false;
        return "";
      }
      const x = 4 + 232 * index / Math.max(1, values.length - 1);
      const y = min === max ? 40 : 72 - 64 * (value - min) / (max - min);
      const point = `${penDown ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
      penDown = true;
      return point;
    }).join(" "));
    return line;
  }
  svg.append(grid, trace(samples));
  if (reference.some(Number.isFinite)) {
    const line = trace(reference);
    line.setAttribute("class", "inverter-trace-reference");
    svg.append(line);
  }
  scale.textContent = `${format.format(min)} a ${format.format(max)} · amostras 1–${samples.length}`;
  figure.append(svg, scale);
  return figure;
}
