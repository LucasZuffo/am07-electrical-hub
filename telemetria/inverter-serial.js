function createInverterSerial() {
  const session = crypto.randomUUID();
  let attempt;
  let closing;
  let commandTail = Promise.resolve();

  async function request(op, fields = {}, keepalive = false) {
    let response;
    try {
      response = await fetch("/api/inversor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, session, ...fields }),
        signal: AbortSignal.timeout(op === "disconnect" ? 4000 : 25000),
        keepalive,
      });
    } catch (error) {
      const message = error.name === "TimeoutError"
        ? "O receptor local demorou a responder. Confira a COM e tente novamente."
        : "Sem acesso ao receptor local. Abra Abrir_Telemetria_Inversor.bat e recarregue a página.";
      throw new Error(message, { cause: error });
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("O receptor local do inversor não respondeu. Verifique a janela de Abrir_Telemetria_Inversor.bat.");
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Falha na comunicação com o inversor.");
    return result;
  }

  function connect(port) {
    attempt = request("connect", { port });
    return attempt;
  }

  function command(action) {
    commandTail = commandTail.catch(() => {}).then(() => request("command", { action }));
    return commandTail;
  }

  function close(unloading = false) {
    if (!attempt) return Promise.resolve();
    if (unloading) return request("disconnect", {}, true);
    closing ??= Promise.allSettled([attempt, commandTail]).then(() => request("disconnect"));
    return closing;
  }

  return {
    ports: () => request("ports"),
    connect,
    read: (name) => request("read", { name }),
    poll: () => request("poll"),
    scope: (config) => request("scope", config),
    setVoltageLimit: (volts) => request("voltage_limit", { volts }),
    selectTorqueMode: () => request("torque_mode"),
    setTorqueReference: (nm) => request("torque_reference", { nm }),
    command,
    close,
  };
}
