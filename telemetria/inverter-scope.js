function scopeTriggerTime(samples, sampleMs, level, edge, windowMs) {
  if (!Number.isFinite(level)) return null;
  const frameEnd = (samples.length - 1) * sampleMs;
  const halfWindow = windowMs / 2;
  let nearestCenter = null;
  for (let index = samples.length - 1; index > 0; index -= 1) {
    const a = samples[index - 1];
    const b = samples[index];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const crossed = edge === "falling" ? a > level && b <= level : a < level && b >= level;
    if (!crossed) continue;
    const time = (index - 1 + (level - a) / (b - a)) * sampleMs;
    if (time >= halfWindow && time <= frameEnd - halfWindow) return time;
    if (nearestCenter === null || Math.abs(time - frameEnd / 2) < Math.abs(nearestCenter - frameEnd / 2)) {
      nearestCenter = time;
    }
  }
  return nearestCenter;
}

function createInverterScopeViewer({ units, captureNow }) {
  const get = (id) => document.getElementById(id);
  const dialog = get("inverterScopeViewer");
  const svg = get("scopeViewerChart");
  const time = get("scopeViewerTime");
  const autoScale = get("scopeViewerAutoScale");
  const scale = get("scopeViewerScale");
  const center = get("scopeViewerCenter");
  const mode = get("scopeViewerMode");
  const edge = get("scopeViewerEdge");
  const level = get("scopeViewerLevel");
  const status = get("scopeViewerStatus");
  const freeze = get("scopeViewerFreeze");
  const arm = get("scopeViewerArm");
  const fullscreen = get("scopeViewerFullscreen");
  const cursorReadout = get("scopeViewerCursor");
  const number = new Intl.NumberFormat("pt-BR", { maximumSignificantDigits: 5 });
  const format = (value) => number.format(Math.abs(value) < 1e-10 ? 0 : value);
  const xDivisions = 10;
  const yDivisions = 8;
  let latest = null;
  let captureSequence = 0;
  let signal = null;
  let opener = null;
  let trace = null;
  let frozen = false;
  let singleComplete = false;
  let armedAfter = 0;
  let geometry = null;
  let cursorPosition = null;

  function element(name, attributes, text) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function windowLength(frame) {
    return time.value === "auto" ? (frame.samples.length - 1) * frame.sampleMs : Number(time.value) * xDivisions;
  }

  function render() {
    if (!dialog.open) return;
    const width = Math.max(280, svg.clientWidth);
    const height = Math.max(240, svg.clientHeight);
    const left = width < 450 ? 59 : 76;
    const top = 19;
    const right = width - 18;
    const bottom = height - 35;
    const duration = trace ? Math.max(0.1, windowLength(trace)) : (time.value === "auto" ? 10 : Number(time.value) * xDivisions);
    const frameEnd = trace ? (trace.samples.length - 1) * trace.sampleMs : 0;
    const trigger = trace?.trigger ?? null;
    const start = trigger === null ? frameEnd - duration : trigger - duration / 2;
    const end = start + duration;
    const partial = trace && (start < -1e-6 || end > frameEnd + 1e-6);
    const origin = trigger ?? start;
    const points = trace?.samples ?? [];
    const visible = points.filter((value, index) => {
      const sampleTime = index * trace.sampleMs;
      return Number.isFinite(value) && sampleTime >= start && sampleTime <= end;
    });
    const minimum = visible.length ? Math.min(...visible) : -1;
    const maximum = visible.length ? Math.max(...visible) : 1;
    const middle = (minimum + maximum) / 2;
    const automaticScale = Math.max((maximum - minimum) * 1.18 / yDivisions, Math.abs(middle) * 1e-5, 0.000001);
    const vertical = autoScale.checked || !scale.validity.valid || !(scale.valueAsNumber > 0)
      ? automaticScale : scale.valueAsNumber;
    const midpoint = autoScale.checked || !center.validity.valid || !Number.isFinite(center.valueAsNumber)
      ? middle : center.valueAsNumber;
    if (autoScale.checked) {
      scale.value = Number(automaticScale.toPrecision(4));
      center.value = Number(middle.toPrecision(5));
    }
    const low = midpoint - vertical * yDivisions / 2;
    const high = midpoint + vertical * yDivisions / 2;
    const x = (t) => left + (t - start) / duration * (right - left);
    const y = (value) => top + (high - value) / (high - low) * (bottom - top);
    const unit = units[signal] ?? "";
    const plot = [];
    const grid = [];
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    for (let column = 0; column <= xDivisions; column += 1) {
      const t = start + column * duration / xDivisions;
      const px = x(t);
      grid.push(`M${px},${top}V${bottom}`);
      if (width >= 580 || column % 2 === 0) {
        plot.push(element("text", { x: px, y: bottom + 21, "text-anchor": "middle" }, format(t - origin)));
      }
    }
    for (let row = 0; row <= yDivisions; row += 1) {
      const value = high - row * vertical;
      const py = y(value);
      grid.push(`M${left},${py}H${right}`);
      if (row % 2 === 0) plot.push(element("text", { x: left - 8, y: py + 4, "text-anchor": "end" }, format(value)));
    }
    svg.replaceChildren(
      element("rect", { x: left, y: top, width: right - left, height: bottom - top, class: "scope-screen-fill" }),
      element("path", { d: grid.join(" "), class: "scope-screen-grid" }),
      ...plot
    );
    const clip = element("clipPath", { id: "scopeViewerClip" });
    clip.append(element("rect", { x: left, y: top, width: right - left, height: bottom - top }));
    svg.append(clip);
    const clipped = element("g", { "clip-path": "url(#scopeViewerClip)" });
    if (trigger !== null) {
      clipped.append(element("path", { class: "scope-trigger", d: `M${x(trigger)},${top}V${bottom}` }));
    }
    if (Number.isFinite(level.valueAsNumber) && level.valueAsNumber >= low && level.valueAsNumber <= high) {
      const py = y(level.valueAsNumber);
      clipped.append(element("path", { class: "scope-trigger-level", d: `M${left},${py}H${right}` }));
    }
    if (trace) {
      let penDown = false;
      const path = [];
      points.forEach((value, index) => {
        const t = index * trace.sampleMs;
        if (!Number.isFinite(value) || t < start - trace.sampleMs || t > end + trace.sampleMs) {
          penDown = false;
          return;
        }
        path.push(`${penDown ? "L" : "M"}${x(t).toFixed(2)},${y(value).toFixed(2)}`);
        penDown = true;
      });
      clipped.append(element("path", { d: path.join(" "), class: "scope-waveform" }));
    }
    const crosshair = element("path", { class: "scope-cursor" });
    clipped.append(crosshair);
    svg.append(clipped);
    geometry = { width, height, left, right, top, bottom, start, origin, duration, low, high, unit, crosshair };
    get("scopeViewerWindow").textContent = `${format(duration / xDivisions)} ms/div · ${format(vertical)} ${unit || "unid."}/div${partial ? " · janela parcial" : ""}`;
    get("scopeViewerStats").textContent = visible.length
      ? `Mín. ${format(minimum)} · Máx. ${format(maximum)} · ${visible.length} amostras`
      : "Sem amostras na janela";
    renderCursor();
  }

  function consumeFrame() {
    if (!dialog.open || frozen || singleComplete || !latest) return;
    const samples = latest.capture.data[latest.capture.names.indexOf(signal)];
    if (!samples?.length) return;
    if (mode.value === "single" && captureSequence <= armedAfter) return;
    const frame = { samples, sampleMs: latest.decimation / 10 };
    const duration = windowLength(frame);
    const trigger = scopeTriggerTime(samples, frame.sampleMs, level.valueAsNumber, edge.value, duration);
    if (trigger === null && mode.value !== "auto") {
      status.textContent = trace ? "Aguardando trigger · última curva mantida" : "Aguardando a borda de trigger";
      return;
    }
    trace = { ...frame, trigger };
    singleComplete = mode.value === "single";
    status.textContent = singleComplete ? "Trigger único concluído"
      : trigger === null ? "Auto · sem cruzamento nesta captura" : "Sincronizado pelo trigger";
    render();
  }

  function resetTrigger() {
    singleComplete = false;
    armedAfter = captureSequence;
    if (!frozen) trace = null;
    if (mode.value === "single") status.textContent = "Trigger único armado · aguardando nova captura";
    else if (!frozen) {
      status.textContent = "Aguardando captura";
      consumeFrame();
    }
    render();
  }

  function open(name, button) {
    signal = name;
    opener = button;
    cursorPosition = null;
    frozen = singleComplete = false;
    trace = null;
    time.value = "auto";
    mode.value = "auto";
    edge.value = "rising";
    autoScale.checked = true;
    scale.disabled = center.disabled = true;
    freeze.setAttribute("aria-pressed", "false");
    freeze.textContent = "Congelar";
    arm.disabled = true;
    const unit = units[name];
    get("inverterScopeTitle").textContent = unit ? `${name} · ${unit}` : name;
    get("scopeViewerScaleUnit").textContent = `${unit || "Unidades"}/div`;
    get("scopeViewerCenterUnit").textContent = unit ? `Centro (${unit})` : "Centro da escala";
    get("scopeViewerLevelUnit").textContent = unit ? `Nível (${unit})` : "Nível";
    const index = latest?.capture.names.indexOf(name);
    const values = (latest?.capture.data[index] ?? []).filter(Number.isFinite);
    level.value = values.length ? Number(((Math.min(...values) + Math.max(...values)) / 2).toPrecision(5)) : 0;
    dialog.showModal();
    resetTrigger();
  }

  get("scopeViewerClose").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (document.fullscreenElement === dialog) document.exitFullscreen().catch(() => {});
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  });
  fullscreen.disabled = !document.fullscreenEnabled;
  fullscreen.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement === dialog) await document.exitFullscreen();
      else await dialog.requestFullscreen();
    } catch {
      status.textContent = "A visualização ocupa a janela do navegador.";
    }
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreen.textContent = document.fullscreenElement === dialog ? "Sair da tela cheia" : "Tela cheia";
  });
  get("scopeViewerCapture").addEventListener("click", captureNow);
  freeze.addEventListener("click", () => {
    frozen = !frozen;
    freeze.setAttribute("aria-pressed", String(frozen));
    freeze.textContent = frozen ? "Retomar" : "Congelar";
    if (frozen) status.textContent = "Curva congelada";
    else if (singleComplete) status.textContent = "Trigger único concluído";
    else {
      status.textContent = "Aguardando captura";
      consumeFrame();
    }
  });
  mode.addEventListener("change", () => {
    arm.disabled = mode.value !== "single";
    resetTrigger();
  });
  [edge, level].forEach((control) => control.addEventListener("change", resetTrigger));
  arm.addEventListener("click", () => {
    if (frozen) freeze.click();
    resetTrigger();
  });
  autoScale.addEventListener("change", () => {
    scale.disabled = center.disabled = autoScale.checked;
    render();
  });
  [scale, center, time].forEach((control) => control.addEventListener("change", () => {
    if (control === time && !frozen && !singleComplete) consumeFrame();
    render();
  }));

  function renderCursor() {
    if (!geometry || !cursorPosition) return clearCursor();
    const { width, height, left, right, top, bottom, start, origin, duration, low, high, unit, crosshair } = geometry;
    const rect = svg.getBoundingClientRect();
    const x = (cursorPosition.x - rect.left) * width / rect.width;
    const y = (cursorPosition.y - rect.top) * height / rect.height;
    if (x < left || x > right || y < top || y > bottom) return clearCursor();
    crosshair.setAttribute("d", `M${x},${top}V${bottom} M${left},${y}H${right}`);
    const t = start - origin + duration * (x - left) / (right - left);
    const amplitude = high - (high - low) * (y - top) / (bottom - top);
    cursorReadout.textContent = `${format(t)} ms · ${format(amplitude)} ${unit}`;
  }
  svg.addEventListener("pointermove", (event) => {
    cursorPosition = { x: event.clientX, y: event.clientY };
    renderCursor();
  });
  function clearCursor() {
    geometry?.crosshair.removeAttribute("d");
    cursorReadout.textContent = "";
  }
  svg.addEventListener("pointerleave", () => {
    cursorPosition = null;
    clearCursor();
  });
  new ResizeObserver(render).observe(svg);

  return {
    open,
    update(capture, decimation) {
      latest = { capture, decimation };
      captureSequence += 1;
      consumeFrame();
    },
    clear() {
      if (dialog.open) dialog.close();
      latest = null;
      trace = null;
    },
    setCaptureEnabled(enabled) {
      get("scopeViewerCapture").disabled = !enabled;
    },
  };
}
