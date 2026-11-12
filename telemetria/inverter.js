function createInverterPanel({ setValue, setArc, connection, setAlert, isRunning }) {
  const get = (id) => document.getElementById(id);
  const panel = get("inverterPanel");
  const port = get("inverterPort");
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
  const commandButtons = [...get("inverterCommands").querySelectorAll("button")];
  const format = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
  const fineFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 });
  const scopeUnits = {
    Id: "A", Iq: "A", Iu: "A", Iv: "A", Iw: "A", Vd: "V", Vq: "V", vbus: "V",
    theta_elec: "rad elét.", theta_est: "rad elét.", theta_err: "rad elét.",
    omega_elec: "rad/s elét.", res_w_lpf: "rad/s elét.", res_sin: "ADC", res_cos: "ADC",
  };
  let socket = null;
  let authenticated = false;
  let connectedPort = null;
  let catalog = [];
  let pending = null;
  let working = false;
  let nextId = 0;
  let displayedParameter = "";
  let motorState = "";
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

  function syncControls() {
    const selected = selectedParameter();
    const editable = connectedPort && selected && !selected.readOnly && (!selected.needsIdle || motorState === "IDLE");
    port.disabled = !authenticated || working || Boolean(connectedPort);
    get("inverterRefresh").disabled = port.disabled;
    get("inverterConnect").disabled = port.disabled || !port.value;
    get("inverterDisconnect").disabled = !connectedPort || working;
    search.disabled = parameter.disabled = !connectedPort || working;
    get("inverterRead").disabled = !connectedPort || !selected || working;
    parameterValue.disabled = !editable || working;
    get("inverterWrite").disabled = !editable || working;
    channels.disabled = get("inverterDecimation").disabled = get("inverterCapture").disabled = !connectedPort || working;
    liveScopeButton.disabled = !connectedPort || working;
    scopeInterval.disabled = liveScopeButton.disabled || Boolean(liveScope);
    scopeCsv.disabled = !lastCapture;
    demoForm.querySelectorAll("input, select, button").forEach((element) => { element.disabled = working; });
    syncDemoReferenceFields();
    commandButtons.forEach((button) => { button.disabled = !connectedPort || working; });
  }

  function setReading(name, value, formatter = format) {
    setValue(name, Number.isFinite(value) ? formatter.format(value) : "--");
  }

  function paintReadings(snapshot = {}, updateValues = true) {
    motorState = snapshot.state ?? "";
    stateBadge.textContent = motorState || "SEM CONEXÃO";
    stateBadge.classList.toggle("bad", Boolean(snapshot.fault) || motorState === "FAULT");
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
    }
    const fault = Boolean(snapshot.fault) || motorState === "FAULT";
    setAlert("dynamics", fault, snapshot.faultReason || "falha informada pelo inversor");
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
    connectedPort = null;
    catalog = [];
    search.value = "";
    filterCatalog();
    showParameter(true);
    channels.querySelectorAll("label").forEach((item) => item.remove());
    scopeStatus.textContent = "";
    lastCapture = null;
    plots.replaceChildren();
    paintReadings();
  }

  function clearPending(error) {
    if (!pending) return;
    const current = pending;
    pending = null;
    current.reject(error);
  }

  function request(op, fields = {}) {
    if (demo) {
      const model = demo;
      return Promise.resolve().then(() => model.request(op, fields));
    }
    if (!authenticated || socket?.readyState !== WebSocket.OPEN || pending) {
      return Promise.reject(new Error("O receptor não está disponível para esta operação."));
    }
    const id = ++nextId;
    const promise = new Promise((resolve, reject) => {
      pending = { id, resolve, reject };
    });
    pending.promise = promise;
    try {
      socket.send(JSON.stringify({ type: "inverter-request", id, op, ...fields }));
    } catch (error) {
      clearPending(error);
    }
    return promise;
  }

  async function perform(op, fields, onResult) {
    if (working || !authenticated) return;
    const session = demo ?? socket;
    working = true;
    syncControls();
    try {
      if (pending) await pending.promise.catch(() => {});
      if ((demo ?? socket) !== session) return;
      const result = await request(op, fields);
      if ((demo ?? socket) === session) onResult(result);
    } catch (error) {
      if ((demo ?? socket) === session) status.textContent = error.message;
    } finally {
      if ((demo ?? socket) === session) {
        working = false;
        syncControls();
      }
    }
  }

  function refreshPorts() {
    perform("ports", {}, (ports) => {
      selectOptions(port, "Selecione uma porta", ports.map((item) => [
        [item.path, item.label, item.recommended ? "USB serial" : ""].filter(Boolean).join(" · "),
        item.path,
      ]));
      status.textContent = ports.length ? "Selecione a porta do inversor." : "Nenhuma porta serial encontrada.";
    });
  }

  function showPanel() {
    panel.hidden = false;
    get("dynamicsRoadSpeed").hidden = true;
    get("dynamicsMotorRpm").hidden = false;
  }

  function start(endpoint, key) {
    showPanel();
    status.textContent = "Acessando o receptor local do inversor…";
    connection("connecting", status.textContent);

    let link;
    try {
      link = new WebSocket(endpoint);
    } catch {
      status.textContent = "Endereço inválido do receptor.";
      connection("error", status.textContent);
      return;
    }
    socket = link;
    const handshake = setTimeout(() => link.close(), 6000);
    let errorMessage = "";
    link.onmessage = (event) => {
      if (socket !== link) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        link.close();
        return;
      }
      if (message.type === "inverter-error" || message.type === "snapshot") {
        errorMessage = message.error || "O receptor nesta porta está em outro modo. Inicie o receptor do inversor.";
        link.close();
      } else if (message.type === "inverter-hello") {
        link.send(JSON.stringify({ type: "inverter-auth", key }));
      } else if (message.type === "inverter-ready") {
        clearTimeout(handshake);
        authenticated = true;
        connection("waiting", "Selecione a porta COM em Dinâmica.");
        refreshPorts();
      } else if (message.type === "inverter-reply" && pending && pending.id === message.id) {
        const operation = pending;
        pending = null;
        if (message.disconnected) {
          clearDevice();
          connection("error", "Conexão serial interrompida.");
        }
        if (message.error) operation.reject(new Error(message.error));
        else operation.resolve(message.result);
      }
    };
    link.onclose = () => {
      clearTimeout(handshake);
      if (socket !== link) return;
      socket = null;
      working = authenticated = false;
      clearPending(new Error("Receptor desconectado."));
      clearDevice();
      status.textContent = errorMessage || "Receptor desconectado. Confira a janela do receptor e reabra Configurar entrada.";
      connection("error", status.textContent);
    };
  }

  function stop() {
    const previous = socket;
    socket = null;
    authenticated = working = false;
    previous?.close();
    clearPending(new Error("Fonte de dados alterada."));
    if (panel.hidden) return;
    clearDevice();
    if (demo) {
      demo = null;
      setDemoAppearance(false);
      Object.assign(get("inverterDecimation"), previousScopeSettings.decimation);
      get("inverterScopeDetails").open = previousScopeSettings.scopeOpen;
      get("inverterCommandDetails").open = previousScopeSettings.commandsOpen;
      previousScopeSettings = null;
    }
    selectOptions(port, "Selecione uma porta", []);
    panel.hidden = get("dynamicsMotorRpm").hidden = true;
    get("dynamicsRoadSpeed").hidden = false;
  }

  function populateChannels(names) {
    names.forEach((name, index) => {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = name;
      checkbox.checked = demo ? ["Id", "Iq", "Iu", "omega_elec"].includes(name) : index < 4;
      label.append(checkbox, name);
      channels.append(label);
    });
  }

  function loadDevice(result) {
    clearDevice();
    connectedPort = result.port;
    catalog = result.parameters;
    filterCatalog();
    populateChannels(result.channels);
    paintReadings(result.snapshot);
  }

  function setDemoAppearance(enabled) {
    get("dynamics").classList.toggle("inverter-demo", enabled);
    get("inverterDemoControls").hidden = get("inverterDemoCurrents").hidden = get("inverterInjectFault").hidden = !enabled;
    const parameterDetails = get("inverterParamDetails");
    const scopeDetails = get("inverterScopeDetails");
    const commandDetails = get("inverterCommandDetails");
    if (enabled) {
      parameterDetails.before(scopeDetails);
      get("inverterDemoControls").append(commandDetails);
    } else {
      scopeDetails.before(parameterDetails);
      panel.append(commandDetails);
    }
    get("inverterPanelMode").textContent = enabled ? "SIMULAÇÃO LOCAL • F28379D" : "USB SERIAL • F28379D";
    get("inverterRead").textContent = enabled ? "Ler parâmetro" : "Ler do MCU";
    get("inverterWrite").textContent = enabled ? "Aplicar parâmetro" : "Gravar no MCU";
    get("inverterTorqueLabel").textContent = enabled ? "TORQUE SIMULADO" : "TORQUE";
    get("inverterPowerLabel").textContent = enabled ? "POTÊNCIA SIMULADA" : "POTÊNCIA";
    get("startInverterDemo").textContent = enabled ? "Reiniciar simulação" : "Simular inversor";
  }

  function syncDemoReferenceFields() {
    const speedMode = demoMode.value === "1";
    get("inverterDemoRpmField").hidden = !speedMode;
    get("inverterDemoTorqueField").hidden = speedMode;
    get("inverterDemoRpm").disabled = working || !speedMode;
    get("inverterDemoTorque").disabled = working || speedMode;
  }

  function showReferences(references) {
    demoMode.value = references.mode;
    get("inverterDemoRpm").value = references.rpm;
    get("inverterDemoTorque").value = references.torque;
    get("inverterDemoCurrent").value = references.currentLimit;
    get("inverterDemoLoad").value = references.load;
    syncDemoReferenceFields();
  }

  function startDemo() {
    demo = createInverterDemo();
    authenticated = true;
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
    setDemoAppearance(true);
    showPanel();
    const result = demo.request("connect");
    loadDevice(result);
    showReferences(result.snapshot.references);
    status.textContent = "Bancada virtual ligada. Ajuste as referências e acompanhe a resposta nos gráficos.";
    connection("simulation", status.textContent);
    beginLiveScope();
  }

  demoMode.addEventListener("change", syncDemoReferenceFields);
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

  get("inverterRefresh").addEventListener("click", refreshPorts);
  port.addEventListener("change", syncControls);
  get("inverterConnect").addEventListener("click", () => {
    status.textContent = `Verificando o protocolo do MCU em ${port.value}…`;
    perform("connect", { port: port.value }, (result) => {
      loadDevice(result);
      status.textContent = `${connectedPort} · ${catalog.length} parâmetros no catálogo.`;
      connection("online", `Inversor conectado em ${connectedPort}`);
    });
  });
  get("inverterDisconnect").addEventListener("click", () => {
    perform("disconnect", {}, () => {
      clearDevice();
      status.textContent = "MCU desconectado.";
      connection("waiting", "Selecione a porta COM em Dinâmica.");
    });
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
    if (!selected || parameterValue.disabled || !Number.isFinite(value)) return;
    if (!demo && !window.confirm(`Gravar ${selected.name} = ${value} ${selected.unit} no inversor em ${connectedPort}?`)) return;
    perform("write", { name: selected.name, value }, (result) => {
      parameterValue.value = result.value ?? "";
      if (demo) showReferences(result.references);
      status.textContent = `${result.name} · valor lido após a escrita: ${result.value ?? "indisponível"} ${selected.unit}`;
    });
  });
  commandButtons.forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.inverterCommand;
    if (action === "inject_fault" && !demo) return;
    if (!demo && action !== "stop" && !window.confirm(`Executar “${button.textContent}” no inversor em ${connectedPort}?`)) return;
    perform("command", { action }, (snapshot) => {
      paintReadings(snapshot);
      status.textContent = `${button.textContent} · estado retornado: ${snapshot.state}.`;
    });
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
    lastCapture = capture;
    plots.replaceChildren(...capture.names.map((name, index) => plotInverterSignal(name, scopeUnits[name], capture.data[index], format)));
    const milliseconds = (capture.n_samples - 1) * decimation / 10;
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
      if (!pending && !working && isRunning()) {
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
    if (config) perform("scope", config, (capture) => renderCapture(capture, config.decimation));
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
    if (!connectedPort || pending || working) return;
    const session = demo ?? socket;
    try {
      const snapshot = await request("poll");
      if ((demo ?? socket) === session) paintReadings(snapshot, isRunning());
    } catch (error) {
      if ((demo ?? socket) === session) status.textContent = error.message;
    }
  }
  setInterval(() => { if (demo) poll(); }, 250);
  setInterval(() => { if (!demo) poll(); }, 1000);

  return { start, startDemo, stop };
}

function plotInverterSignal(name, unit, samples, format) {
  const figure = document.createElement("figure");
  const caption = document.createElement("figcaption");
  caption.textContent = unit ? `${name} (${unit})` : name;
  const scale = document.createElement("small");
  scale.className = "inverter-plot-scale";
  figure.append(caption);
  const numeric = samples.filter(Number.isFinite);
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
  const line = document.createElementNS(svg.namespaceURI, "path");
  let penDown = false;
  const points = samples.map((value, index) => {
    if (!Number.isFinite(value)) {
      penDown = false;
      return "";
    }
    const x = 4 + 232 * index / Math.max(1, samples.length - 1);
    const y = min === max ? 40 : 72 - 64 * (value - min) / (max - min);
    const point = `${penDown ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    penDown = true;
    return point;
  });
  line.setAttribute("d", points.join(" "));
  svg.append(grid, line);
  scale.textContent = `${format.format(min)} a ${format.format(max)} · amostras 1–${samples.length}`;
  figure.append(svg, scale);
  return figure;
}
