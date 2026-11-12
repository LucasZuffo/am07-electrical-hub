(() => {
  "use strict";

  const STORAGE_KEY = "ufprFormula.telemetriaEV.inventory.v1";
  const BACKUP_KEY = `${STORAGE_KEY}.backup`;
  const EXPORT_FORMAT = "ufpr-formula-inventory";
  const SCHEMA_VERSION = 3;
  const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2, SCHEMA_VERSION]);
  const MAX_ITEMS = 2000;
  const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
  const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_STORED_IMAGE_BYTES = 650 * 1024;
  const MAX_DATASHEET_BYTES = 10 * 1024 * 1024;
  const IMAGE_DB_NAME = "ufprFormulaTelemetryLocal";
  const IMAGE_STORE_NAME = "inventoryImages";

  const elements = {
    list: document.getElementById("inventoryList"),
    empty: document.getElementById("inventoryEmptyState"),
    emptyLabel: document.getElementById("inventoryEmptyLabel"),
    emptyTitle: document.getElementById("inventoryEmptyTitle"),
    emptyDescription: document.getElementById("inventoryEmptyDescription"),
    add: document.getElementById("inventoryAddButton"),
    emptyAdd: document.getElementById("inventoryEmptyAddButton"),
    search: document.getElementById("inventorySearch"),
    categoryFilter: document.getElementById("inventoryCategoryFilter"),
    stockFilter: document.getElementById("inventoryStockFilter"),
    sort: document.getElementById("inventorySort"),
    result: document.getElementById("inventoryResultText"),
    skuCount: document.getElementById("inventorySkuCount"),
    unitCount: document.getElementById("inventoryUnitCount"),
    unitBreakdown: document.getElementById("inventoryUnitBreakdown"),
    lowCount: document.getElementById("inventoryLowCount"),
    valueTotal: document.getElementById("inventoryValueTotal"),
    categoryCount: document.getElementById("inventoryCategoryCount"),
    storageState: document.getElementById("inventoryStorageState"),
    importButton: document.getElementById("inventoryImportButton"),
    importInput: document.getElementById("inventoryImportInput"),
    exportButton: document.getElementById("inventoryExportButton"),
    xlsxButton: document.getElementById("inventoryXlsxButton"),
    csvButton: document.getElementById("inventoryCsvButton"),
    modal: document.getElementById("inventoryModal"),
    dialog: document.querySelector("#inventoryModal .inventory-dialog"),
    dialogTitle: document.getElementById("inventoryDialogTitle"),
    close: document.getElementById("inventoryClose"),
    cancel: document.getElementById("inventoryCancel"),
    form: document.getElementById("inventoryForm"),
    id: document.getElementById("inventoryItemId"),
    name: document.getElementById("inventoryName"),
    sku: document.getElementById("inventorySku"),
    category: document.getElementById("inventoryCategory"),
    quantity: document.getElementById("inventoryQuantity"),
    unit: document.getElementById("inventoryUnit"),
    minimum: document.getElementById("inventoryMinimum"),
    lowStockOverride: document.getElementById("inventoryLowStockOverride"),
    unitCost: document.getElementById("inventoryUnitCost"),
    manufacturer: document.getElementById("inventoryManufacturer"),
    location: document.getElementById("inventoryLocation"),
    notes: document.getElementById("inventoryNotes"),
    datasheetUrl: document.getElementById("inventoryDatasheetUrl"),
    chooseDatasheet: document.getElementById("inventoryChooseDatasheet"),
    datasheetInput: document.getElementById("inventoryDatasheetInput"),
    datasheetSummary: document.getElementById("inventoryDatasheetSummary"),
    datasheetName: document.getElementById("inventoryDatasheetName"),
    datasheetStatus: document.getElementById("inventoryDatasheetStatus"),
    removeDatasheet: document.getElementById("inventoryRemoveDatasheet"),
    chooseImage: document.getElementById("inventoryChooseImage"),
    imageInput: document.getElementById("inventoryImageInput"),
    imagePreview: document.getElementById("inventoryImagePreview"),
    previewImage: document.getElementById("inventoryPreviewImage"),
    previewPlaceholder: document.getElementById("inventoryPreviewPlaceholder"),
    removeImage: document.getElementById("inventoryRemoveImage"),
    imageStatus: document.getElementById("inventoryImageStatus"),
    save: document.getElementById("inventorySave")
  };

  if (!elements.list || !elements.form || !elements.modal) return;

  const appShell = document.querySelector(".app-shell");
  const unitLabels = {
    un: "un",
    par: "par",
    kit: "kit",
    m: "m",
    cm: "cm",
    rolo: "rolo",
    caixa: "caixa"
  };
  const validUnits = new Set(Object.keys(unitLabels));

  let items = [];
  let revision = 0;
  let storageAvailable = true;
  let imageDatabaseAvailable = true;
  let imageDatabasePromise = null;
  let renderGeneration = 0;
  let cardObjectUrls = [];
  let draftImageBlob;
  let draftImagePreviewUrl = null;
  let draftDatasheetBlob;
  let draftDatasheetMetadata = null;
  let modalTrigger = elements.add;
  let searchTimer = null;
  let pendingExternalInventoryUpdate = false;

  function notify(message) {
    if (typeof window.showToast === "function") {
      window.showToast(message);
      return;
    }

    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(notify.timeout);
    notify.timeout = setTimeout(() => toast.classList.remove("show"), 3400);
  }

  function normalizeWhitespace(value, maxLength) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
  }

  function normalizeNotes(value) {
    return String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, 500);
  }

  function finiteNumber(value, fallback = 0, max = 1_000_000_000) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(0, Math.round(number * 100) / 100));
  }

  function createId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function normalizeDatasheetUrl(value) {
    const candidate = normalizeWhitespace(value, 500);
    if (!candidate) return "";
    try {
      const parsed = new URL(candidate);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
      return parsed.href.length <= 500 ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function normalizeItem(raw, { allowNewId = true } = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

    const name = normalizeWhitespace(raw.name, 80);
    const category = normalizeWhitespace(raw.category ?? raw.type, 50);
    if (!name || !category) return null;

    const id = normalizeWhitespace(raw.id, 80) || (allowNewId ? createId() : "");
    if (!id) return null;

    const createdAtCandidate = Date.parse(raw.createdAt);
    const updatedAtCandidate = Date.parse(raw.updatedAt);
    const now = new Date().toISOString();
    const minimumRaw = raw.minimum ?? raw.minimumQuantity ?? raw.minQuantity;
    const unitCostRaw = raw.unitCost ?? raw.cost;
    const minimumKnown = raw.minimumKnown !== false && minimumRaw !== null && minimumRaw !== undefined && String(minimumRaw).trim() !== "";
    const normalizedUnitCost = finiteNumber(unitCostRaw);
    const unitCostKnown = raw.unitCostKnown === true || (raw.unitCostKnown !== false && normalizedUnitCost > 0);

    return {
      id,
      name,
      sku: normalizeWhitespace(raw.sku ?? raw.code ?? raw.partNumber, 40),
      category,
      quantity: finiteNumber(raw.quantity),
      quantityKnown: raw.quantityKnown !== false,
      unit: validUnits.has(raw.unit) ? raw.unit : "un",
      minimum: finiteNumber(minimumRaw),
      minimumKnown,
      stockAlert: raw.stockAlert === "low" || raw.manualLowStock === true || raw.sourceLowStock === true ? "low" : "",
      unitCost: normalizedUnitCost,
      unitCostKnown,
      manufacturer: normalizeWhitespace(raw.manufacturer, 60),
      location: normalizeWhitespace(raw.location, 60),
      notes: normalizeNotes(raw.notes),
      hasImage: Boolean(raw.hasImage),
      datasheetUrl: normalizeDatasheetUrl(raw.datasheetUrl ?? raw.datasheetLink),
      hasDatasheet: Boolean(raw.hasDatasheet ?? raw.hasDatasheetFile),
      datasheetName: normalizeWhitespace(raw.datasheetName ?? raw.datasheetFileName, 120),
      datasheetSize: finiteNumber(raw.datasheetSize, 0, MAX_DATASHEET_BYTES),
      createdAt: Number.isFinite(createdAtCandidate) ? new Date(createdAtCandidate).toISOString() : now,
      updatedAt: Number.isFinite(updatedAtCandidate) ? new Date(updatedAtCandidate).toISOString() : now
    };
  }

  function parseInventoryDocument(raw) {
    const documentValue = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!SUPPORTED_SCHEMA_VERSIONS.has(documentValue?.schemaVersion) || !Array.isArray(documentValue.items)) {
      throw new Error("formato de estoque incompatível");
    }

    const uniqueIds = new Set();
    const uniqueSkus = new Set();
    const normalized = [];
    documentValue.items.slice(0, MAX_ITEMS).forEach((rawItem) => {
      const item = normalizeItem(rawItem, { allowNewId: false });
      if (!item || uniqueIds.has(item.id)) return;
      const skuKey = normalizeSearch(item.sku);
      if (skuKey && uniqueSkus.has(skuKey)) return;
      uniqueIds.add(item.id);
      if (skuKey) uniqueSkus.add(skuKey);
      normalized.push(item);
    });

    return {
      items: normalized,
      revision: finiteNumber(documentValue.revision, 0, Number.MAX_SAFE_INTEGER)
    };
  }

  function readInventory() {
    let primaryRaw = null;
    try {
      primaryRaw = localStorage.getItem(STORAGE_KEY);
      if (!primaryRaw) {
        storageAvailable = true;
        return;
      }
      const loaded = parseInventoryDocument(primaryRaw);
      items = loaded.items;
      revision = loaded.revision;
      storageAvailable = true;
      return;
    } catch (primaryError) {
      console.error("Não foi possível carregar o estoque local principal:", primaryError);
    }

    try {
      const backupRaw = localStorage.getItem(BACKUP_KEY);
      if (!backupRaw) throw new Error("backup local indisponível");
      const recovered = parseInventoryDocument(backupRaw);
      items = recovered.items;
      revision = Math.max(recovered.revision, Date.now());
      if (primaryRaw) {
        try {
          localStorage.setItem(`${STORAGE_KEY}.corrupt.${Date.now()}`, primaryRaw);
        } catch {}
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        format: EXPORT_FORMAT,
        schemaVersion: SCHEMA_VERSION,
        revision,
        recoveredAt: new Date().toISOString(),
        items
      }));
      storageAvailable = true;
      notify("Estoque recuperado a partir do backup local de segurança.");
    } catch (backupError) {
      items = [];
      revision = 0;
      storageAvailable = false;
      console.error("Não foi possível recuperar o estoque local:", backupError);
      notify("O estoque local não pôde ser lido. Importe um Backup JSON para recuperá-lo.");
    }
  }

  function persistInventory(nextItems) {
    const nextRevision = Math.max(revision + 1, Date.now());
    const documentValue = {
      format: EXPORT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      revision: nextRevision,
      updatedAt: new Date().toISOString(),
      items: nextItems
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(documentValue));
      items = nextItems;
      revision = nextRevision;
      storageAvailable = true;
      updateStorageState();
      return true;
    } catch (error) {
      storageAvailable = false;
      updateStorageState();
      console.error("Não foi possível salvar o estoque:", error);
      notify("Falha ao salvar. Faça um backup e verifique o espaço do navegador.");
      return false;
    }
  }

  function updateStorageState() {
    const messages = [];
    if (storageAvailable) messages.push("salvo neste navegador");
    else messages.push("metadados sem persistência");
    if (!imageDatabaseAvailable) messages.push("imagens e anexos indisponíveis");
    elements.storageState.textContent = messages.join(" · ");
    elements.storageState.dataset.state = storageAvailable && imageDatabaseAvailable ? "ok" : "error";
    elements.storageState.title = "Os dados não são enviados para a nuvem e não acompanham o ZIP. Use Backup JSON para transferi-los.";
  }

  function openImageDatabase() {
    if (imageDatabasePromise) return imageDatabasePromise;
    imageDatabasePromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB não disponível"));
        return;
      }

      const request = window.indexedDB.open(IMAGE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(IMAGE_STORE_NAME)) {
          database.createObjectStore(IMAGE_STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Falha ao abrir banco de imagens"));
      request.onblocked = () => reject(new Error("Banco de imagens bloqueado por outra aba"));
    }).catch((error) => {
      imageDatabaseAvailable = false;
      imageDatabasePromise = null;
      updateStorageState();
      console.warn("Imagens locais indisponíveis:", error);
      throw error;
    });
    return imageDatabasePromise;
  }

  async function imageStoreOperation(mode, callback) {
    const database = await openImageDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(IMAGE_STORE_NAME, mode);
      const store = transaction.objectStore(IMAGE_STORE_NAME);
      let request;
      try {
        request = callback(store);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error ?? request?.error ?? new Error("Falha no banco de imagens"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Operação de imagem cancelada"));
    });
  }

  function getImage(id) {
    return imageStoreOperation("readonly", (store) => store.get(id)).then((record) => record?.blob ?? null);
  }

  function putImage(id, blob) {
    return imageStoreOperation("readwrite", (store) => store.put({ id, blob, updatedAt: new Date().toISOString() }));
  }

  function deleteImage(id) {
    return imageStoreOperation("readwrite", (store) => store.delete(id));
  }

  function datasheetStorageKey(id) {
    return ["datasheet", id];
  }

  function getDatasheet(id) {
    return imageStoreOperation("readonly", (store) => store.get(datasheetStorageKey(id)))
      .then((record) => record?.blob ? record : null);
  }

  function putDatasheet(id, blob, metadata = {}) {
    return imageStoreOperation("readwrite", (store) => store.put({
      id: datasheetStorageKey(id),
      blob,
      fileName: normalizeWhitespace(metadata.fileName, 120) || "datasheet.pdf",
      mimeType: "application/pdf",
      size: blob.size,
      updatedAt: new Date().toISOString()
    }));
  }

  function deleteDatasheet(id) {
    return imageStoreOperation("readwrite", (store) => store.delete(datasheetStorageKey(id)));
  }

  function normalizeSearch(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("pt-BR")
      .trim();
  }

  function inventoryFingerprint(item) {
    return normalizeSearch([item.name, item.category, item.location, item.unit].join("|"));
  }

  function applyBundledInventorySeed() {
    const seed = window.UFPR_FORMULA_INVENTORY_SEED;
    if (!storageAvailable || !seed || typeof seed !== "object" || !Array.isArray(seed.items)) return 0;
    const seedVersion = normalizeWhitespace(seed.seedVersion, 100);
    if (!seedVersion || seed.items.length > MAX_ITEMS) return 0;
    const markerKey = `${STORAGE_KEY}.seed.${seedVersion}`;

    try {
      if (localStorage.getItem(markerKey)) return 0;
    } catch {
      return 0;
    }

    const existingIds = new Set(items.map((item) => item.id));
    const existingSkus = new Set(items.map((item) => normalizeSearch(item.sku)).filter(Boolean));
    const existingFingerprints = new Set(items.map(inventoryFingerprint));
    const additions = [];

    seed.items.forEach((rawItem) => {
      const item = normalizeItem(rawItem, { allowNewId: false });
      if (!item || existingIds.has(item.id)) return;
      const skuKey = normalizeSearch(item.sku);
      const fingerprint = inventoryFingerprint(item);
      if ((skuKey && existingSkus.has(skuKey)) || existingFingerprints.has(fingerprint)) return;
      existingIds.add(item.id);
      if (skuKey) existingSkus.add(skuKey);
      existingFingerprints.add(fingerprint);
      additions.push(item);
    });

    if (items.length + additions.length > MAX_ITEMS) {
      notify(`A carga inicial precisa de ${additions.length} vagas, mas o estoque suporta no máximo ${MAX_ITEMS} componentes. Nenhum item da carga foi adicionado.`);
      return 0;
    }

    if (additions.length > 0 && !persistInventory([...items, ...additions])) return 0;
    try {
      localStorage.setItem(markerKey, JSON.stringify({
        appliedAt: new Date().toISOString(),
        sourceSha256: normalizeWhitespace(seed.source?.sha256, 80),
        addedItems: additions.length
      }));
    } catch (error) {
      console.warn("A carga do inventário foi salva, mas o marcador de versão não pôde ser gravado:", error);
    }
    return additions.length;
  }

  function stockState(item) {
    if (item.quantityKnown === false) return "unknown";
    if (item.quantity <= 0) return "out";
    if (item.stockAlert === "low") return "low";
    if (item.minimumKnown !== false && item.quantity <= item.minimum) return "low";
    return "available";
  }

  function stockStatusLabel(item) {
    const status = stockState(item);
    if (status === "unknown") return "SEM CONTAGEM";
    if (status === "out") return "ESGOTADO";
    if (status === "low") return "ESTOQUE BAIXO";
    return "DISPONÍVEL";
  }

  function formatQuantity(value) {
    return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(value);
  }

  function formatCurrency(value) {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
  }

  function unitBreakdown(sourceItems) {
    const totals = new Map();
    const countedItems = sourceItems.filter((item) => item.quantityKnown !== false);
    const unknownCount = sourceItems.length - countedItems.length;
    countedItems.forEach((item) => totals.set(item.unit, (totals.get(item.unit) ?? 0) + item.quantity));
    const parts = Array.from(totals, ([unit, total]) => `${formatQuantity(total)} ${unitLabels[unit] ?? unit}`);
    const totalLabel = parts.length
      ? parts.slice(0, 3).join(" · ") + (parts.length > 3 ? ` · +${parts.length - 3}` : "")
      : "somatório em estoque";
    return unknownCount > 0 ? `${totalLabel} · ${unknownCount} sem contagem` : totalLabel;
  }

  function currentFilteredItems() {
    const terms = normalizeSearch(elements.search.value).split(/\s+/).filter(Boolean);
    const category = elements.categoryFilter.value;
    const stock = elements.stockFilter.value;
    const filtered = items.filter((item) => {
      const haystack = normalizeSearch([
        item.name,
        item.sku,
        item.category,
        item.manufacturer,
        item.location,
        item.notes,
        item.datasheetName,
        item.datasheetUrl
      ].join(" "));
      return terms.every((term) => haystack.includes(term))
        && (category === "all" || item.category === category)
        && (stock === "all" || stockState(item) === stock);
    });

    const sorted = [...filtered];
    switch (elements.sort.value) {
      case "name":
        sorted.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
        break;
      case "quantity-desc":
        sorted.sort((a, b) => (
          Number(a.quantityKnown === false) - Number(b.quantityKnown === false)
          || b.quantity - a.quantity
          || a.name.localeCompare(b.name, "pt-BR")
        ));
        break;
      case "quantity-asc":
        sorted.sort((a, b) => (
          Number(a.quantityKnown === false) - Number(b.quantityKnown === false)
          || a.quantity - b.quantity
          || a.name.localeCompare(b.name, "pt-BR")
        ));
        break;
      case "category":
        sorted.sort((a, b) => a.category.localeCompare(b.category, "pt-BR") || a.name.localeCompare(b.name, "pt-BR"));
        break;
      default:
        sorted.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    }
    return sorted;
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function initials(name) {
    return name.split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("").toLocaleUpperCase("pt-BR") || "—";
  }

  function appendMeta(container, label, value) {
    const wrapper = makeElement("div");
    wrapper.append(makeElement("small", "", label), makeElement("span", "", value || "—"));
    container.append(wrapper);
  }

  function createInventoryCard(item) {
    const status = stockState(item);
    const statusLabel = stockStatusLabel(item);
    const card = makeElement("article", "inventory-card");
    card.dataset.inventoryId = item.id;
    card.dataset.stock = status;
    card.setAttribute("role", "listitem");

    const imageBox = makeElement("div", "inventory-card-image");
    const image = document.createElement("img");
    image.alt = `Imagem de ${item.name}`;
    image.hidden = true;
    image.dataset.inventoryImage = item.id;
    const imageFallback = makeElement("span", "", initials(item.name));
    imageFallback.dataset.inventoryImageFallback = item.id;
    imageBox.append(image, imageFallback);

    const content = makeElement("div", "inventory-card-content");
    const top = makeElement("div", "inventory-card-top");
    const titleBox = makeElement("div");
    titleBox.append(makeElement("small", "inventory-card-type", item.category), makeElement("h3", "", item.name));
    top.append(titleBox, makeElement("span", "inventory-stock-badge", statusLabel));

    const code = makeElement("p", "inventory-card-code", item.sku ? `PN · ${item.sku}` : "SEM CÓDIGO INFORMADO");
    const meta = makeElement("div", "inventory-card-meta");
    appendMeta(meta, "FABRICANTE", item.manufacturer);
    appendMeta(meta, "LOCALIZAÇÃO", item.location);
    appendMeta(meta, "ESTOQUE MÍNIMO", item.minimumKnown === false ? "não informado" : `${formatQuantity(item.minimum)} ${unitLabels[item.unit]}`);
    appendMeta(meta, "VALOR DO ITEM", item.quantityKnown === false
      ? "sem contagem"
      : item.unitCostKnown === false ? "não informado" : formatCurrency(item.quantity * item.unitCost));

    const quantity = makeElement("div", "inventory-card-quantity");
    const quantityValue = makeElement("div", "inventory-quantity-value");
    quantityValue.append(makeElement("small", "", "QUANTIDADE ATUAL"));
    const quantityStrong = makeElement("strong", "", item.quantityKnown === false ? "—" : formatQuantity(item.quantity));
    quantityStrong.append(makeElement("em", "", item.quantityKnown === false ? "sem contagem" : unitLabels[item.unit] ?? item.unit));
    quantityValue.append(quantityStrong);

    const stepper = makeElement("div", "inventory-stepper");
    const decrement = makeElement("button", "", "−");
    decrement.type = "button";
    decrement.dataset.action = "decrement";
    decrement.disabled = item.quantityKnown === false || item.quantity <= 0;
    decrement.setAttribute("aria-label", `Retirar 1 ${unitLabels[item.unit]} de ${item.name}`);
    const increment = makeElement("button", "", "+");
    increment.type = "button";
    increment.dataset.action = "increment";
    increment.disabled = item.quantityKnown !== false && item.quantity >= 1_000_000_000;
    increment.setAttribute("aria-label", item.quantityKnown === false
      ? `Iniciar a contagem de ${item.name} com 1 ${unitLabels[item.unit]}`
      : `Adicionar 1 ${unitLabels[item.unit]} de ${item.name}`);
    stepper.append(decrement, increment);
    quantity.append(quantityValue, stepper);

    const actions = makeElement("div", "inventory-card-actions");
    if (item.hasDatasheet || item.datasheetUrl) {
      const datasheet = makeElement("button", "", "DATASHEET");
      datasheet.type = "button";
      datasheet.dataset.action = "datasheet";
      datasheet.setAttribute("aria-label", `Abrir datasheet de ${item.name}`);
      datasheet.title = item.hasDatasheet
        ? item.datasheetName || "Abrir PDF anexado"
        : "Abrir link do datasheet";
      actions.append(datasheet);
    }
    const edit = makeElement("button", "", "EDITAR");
    edit.type = "button";
    edit.dataset.action = "edit";
    edit.setAttribute("aria-label", `Editar ${item.name}`);
    const remove = makeElement("button", "", "EXCLUIR");
    remove.type = "button";
    remove.dataset.action = "delete";
    remove.setAttribute("aria-label", `Excluir ${item.name}`);
    actions.append(edit, remove);

    content.append(top, code, meta, quantity, actions);
    card.append(imageBox, content);
    return card;
  }

  function releaseCardImages() {
    cardObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    cardObjectUrls = [];
  }

  async function hydrateCardImages(filteredItems, generation) {
    if (!imageDatabaseAvailable) return;
    await Promise.all(filteredItems.filter((item) => item.hasImage).map(async (item) => {
      try {
        const blob = await getImage(item.id);
        if (!blob || generation !== renderGeneration) return;
        const image = elements.list.querySelector(`[data-inventory-image="${CSS.escape(item.id)}"]`);
        const fallback = elements.list.querySelector(`[data-inventory-image-fallback="${CSS.escape(item.id)}"]`);
        if (!image) return;
        const url = URL.createObjectURL(blob);
        cardObjectUrls.push(url);
        image.onload = () => {
          image.hidden = false;
          if (fallback) fallback.hidden = true;
        };
        image.src = url;
      } catch (error) {
        console.warn(`Imagem de ${item.id} indisponível:`, error);
      }
    }));
  }

  function updateCategoryFilter() {
    const selected = elements.categoryFilter.value;
    const categories = Array.from(new Set(items.map((item) => item.category))).sort((a, b) => a.localeCompare(b, "pt-BR"));
    elements.categoryFilter.replaceChildren();
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = "Todos os tipos";
    elements.categoryFilter.append(all);
    categories.forEach((category) => {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      elements.categoryFilter.append(option);
    });
    elements.categoryFilter.value = categories.includes(selected) ? selected : "all";
  }

  function updateSummary() {
    const lowCount = items.filter((item) => ["low", "out"].includes(stockState(item))).length;
    const countedItems = items.filter((item) => item.quantityKnown !== false);
    const valuedItems = countedItems.filter((item) => item.unitCostKnown !== false);
    const unitKinds = new Set(countedItems.map((item) => item.unit));
    const totalValue = valuedItems.reduce((total, item) => total + item.quantity * item.unitCost, 0);
    const categories = new Set(items.map((item) => item.category));
    elements.skuCount.textContent = formatQuantity(items.length);
    elements.unitCount.textContent = unitKinds.size === 0
      ? "0"
      : unitKinds.size === 1
        ? unitBreakdown(countedItems)
        : `${formatQuantity(unitKinds.size)} grupos`;
    elements.unitBreakdown.textContent = unitBreakdown(items);
    elements.unitCount.title = unitBreakdown(items);
    elements.lowCount.textContent = formatQuantity(lowCount);
    elements.lowCount.closest(".inventory-kpi")?.setAttribute("data-active", lowCount > 0 ? "true" : "false");
    elements.valueTotal.textContent = valuedItems.length > 0 ? formatCurrency(totalValue) : "não informado";
    elements.valueTotal.title = valuedItems.length > 0
      ? `Somatório de ${valuedItems.length} cadastro(s) com custo informado`
      : "Nenhum componente possui custo unitário informado";
    elements.categoryCount.textContent = formatQuantity(categories.size);
  }

  function updateEmptyState(filteredItems) {
    const hasItems = items.length > 0;
    const hasResults = filteredItems.length > 0;
    elements.empty.hidden = hasResults;
    if (hasResults) return;

    if (hasItems) {
      elements.emptyLabel.textContent = "NENHUM RESULTADO";
      elements.emptyTitle.textContent = "Nenhum componente encontrado";
      elements.emptyDescription.textContent = "Ajuste a busca ou os filtros para localizar outros componentes do estoque.";
      elements.emptyAdd.textContent = "Limpar filtros";
      elements.emptyAdd.dataset.action = "clear-filters";
    } else {
      elements.emptyLabel.textContent = "ESTOQUE AINDA VAZIO";
      elements.emptyTitle.textContent = "Cadastre o primeiro componente";
      elements.emptyDescription.textContent = "Inclua quantidade, tipo, localização, custo e uma imagem para encontrar qualquer peça rapidamente.";
      elements.emptyAdd.textContent = "Adicionar primeiro componente";
      elements.emptyAdd.dataset.action = "add";
    }
  }

  function renderInventory() {
    updateCategoryFilter();
    updateSummary();
    updateStorageState();
    const filteredItems = currentFilteredItems();
    const generation = ++renderGeneration;
    releaseCardImages();
    const fragment = document.createDocumentFragment();
    filteredItems.forEach((item) => fragment.append(createInventoryCard(item)));
    elements.list.replaceChildren(fragment);
    elements.result.textContent = items.length === 0
      ? "Nenhum componente cadastrado"
      : `Exibindo ${filteredItems.length} de ${items.length} itens · ${unitBreakdown(filteredItems)}`;
    updateEmptyState(filteredItems);
    hydrateCardImages(filteredItems, generation);
  }

  function clearFilters() {
    elements.search.value = "";
    elements.categoryFilter.value = "all";
    elements.stockFilter.value = "all";
    elements.sort.value = "updated";
    renderInventory();
    elements.search.focus();
  }

  function releaseDraftPreview() {
    if (draftImagePreviewUrl) URL.revokeObjectURL(draftImagePreviewUrl);
    draftImagePreviewUrl = null;
  }

  function showDraftImage(blob) {
    releaseDraftPreview();
    if (!blob) {
      elements.previewImage.hidden = true;
      elements.previewImage.removeAttribute("src");
      elements.previewPlaceholder.hidden = false;
      elements.imagePreview.dataset.empty = "true";
      elements.removeImage.hidden = true;
      return;
    }
    draftImagePreviewUrl = URL.createObjectURL(blob);
    elements.previewImage.src = draftImagePreviewUrl;
    elements.previewImage.hidden = false;
    elements.previewPlaceholder.hidden = true;
    elements.imagePreview.dataset.empty = "false";
    elements.removeImage.hidden = false;
  }

  function setImageStatus(message, state = "ok") {
    elements.imageStatus.textContent = message;
    elements.imageStatus.dataset.state = state;
  }

  function formatAssetSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "tamanho não informado";
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
    return `${Math.ceil(bytes / 1024).toLocaleString("pt-BR")} KB`;
  }

  function showDraftDatasheet(metadata, message = "PDF de até 10 MB", state = "ok") {
    const hasFile = Boolean(metadata?.fileName);
    elements.datasheetSummary.dataset.empty = hasFile ? "false" : "true";
    elements.datasheetName.textContent = hasFile ? metadata.fileName : "Sem PDF anexado";
    elements.datasheetStatus.textContent = hasFile
      ? `${formatAssetSize(metadata.size)} · ${message}`
      : message;
    elements.datasheetStatus.dataset.state = state;
    elements.removeDatasheet.hidden = !hasFile;
  }

  async function validateDatasheetFile(file) {
    const fileName = normalizeWhitespace(file?.name, 120);
    if (!file || !fileName || !fileName.toLocaleLowerCase("pt-BR").endsWith(".pdf")) {
      throw new Error("Escolha um arquivo com extensão .pdf.");
    }
    if (file.type && file.type !== "application/pdf") throw new Error("O arquivo selecionado não foi identificado como PDF.");
    if (file.size <= 0) throw new Error("O PDF selecionado está vazio.");
    if (file.size > MAX_DATASHEET_BYTES) throw new Error("O datasheet deve ter no máximo 10 MB.");
    const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    const signature = String.fromCharCode(...header);
    if (signature !== "%PDF-") throw new Error("O arquivo não possui uma assinatura PDF válida.");
    return {
      blob: file.slice(0, file.size, "application/pdf"),
      metadata: { fileName, size: file.size, mimeType: "application/pdf" }
    };
  }

  async function openInventoryModal(id = null, trigger = null) {
    modalTrigger = trigger ?? document.activeElement ?? elements.add;
    elements.form.reset();
    elements.id.value = "";
    elements.quantity.value = "";
    elements.minimum.value = "";
    if (elements.lowStockOverride) elements.lowStockOverride.checked = false;
    elements.unit.value = "un";
    elements.form.querySelectorAll("[aria-invalid]").forEach((field) => field.removeAttribute("aria-invalid"));
    draftImageBlob = undefined;
    draftDatasheetBlob = undefined;
    draftDatasheetMetadata = null;
    showDraftImage(null);
    showDraftDatasheet(null);
    setImageStatus("PNG, JPG ou WebP. A imagem será reduzida para economizar espaço.");

    const item = id ? items.find((candidate) => candidate.id === id) : null;
    elements.dialogTitle.textContent = item ? "Editar componente" : "Adicionar componente";
    elements.save.textContent = item ? "Salvar alterações" : "Salvar componente";

    if (item) {
      elements.id.value = item.id;
      elements.name.value = item.name;
      elements.sku.value = item.sku;
      elements.category.value = item.category;
      elements.quantity.value = item.quantityKnown === false ? "" : item.quantity;
      elements.unit.value = item.unit;
      elements.minimum.value = item.minimumKnown === false ? "" : item.minimum;
      if (elements.lowStockOverride) elements.lowStockOverride.checked = item.stockAlert === "low";
      elements.unitCost.value = item.unitCostKnown === false ? "" : item.unitCost;
      elements.manufacturer.value = item.manufacturer;
      elements.location.value = item.location;
      elements.notes.value = item.notes;
      elements.datasheetUrl.value = item.datasheetUrl;
      if (item.hasDatasheet) {
        draftDatasheetMetadata = { fileName: item.datasheetName || "datasheet.pdf", size: item.datasheetSize };
        showDraftDatasheet(draftDatasheetMetadata, "salvo localmente neste navegador");
      } else if (item.datasheetUrl) {
        showDraftDatasheet(null, "Link externo do fabricante cadastrado.");
      }
      if (item.hasImage && imageDatabaseAvailable) {
        setImageStatus("Carregando imagem salva…");
        try {
          const blob = await getImage(item.id);
          if (elements.id.value === item.id && blob) {
            showDraftImage(blob);
            setImageStatus("Imagem salva localmente neste navegador.");
          } else if (!blob) {
            setImageStatus("A referência da imagem existe, mas o arquivo não foi encontrado.", "error");
          }
        } catch {
          setImageStatus("Não foi possível carregar a imagem local.", "error");
        }
      }
    }

    elements.modal.hidden = false;
    if (appShell) appShell.inert = true;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => elements.name.focus());
  }

  function closeInventoryModal(options = {}) {
    const restoreFocus = options?.restoreFocus !== false;
    const reloadExternalUpdate = pendingExternalInventoryUpdate;
    pendingExternalInventoryUpdate = false;
    elements.modal.hidden = true;
    if (appShell) appShell.inert = false;
    document.body.style.removeProperty("overflow");
    releaseDraftPreview();
    draftImageBlob = undefined;
    draftDatasheetBlob = undefined;
    draftDatasheetMetadata = null;
    elements.imageInput.value = "";
    elements.datasheetInput.value = "";
    elements.save.disabled = false;
    if (restoreFocus && modalTrigger instanceof HTMLElement) modalTrigger.focus();
    if (reloadExternalUpdate) {
      items = [];
      readInventory();
      renderInventory();
      notify("Alterações de outra aba foram carregadas; o formulário anterior não foi salvo.");
    }
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Falha ao gerar imagem")), type, quality));
  }

  async function loadBitmap(file) {
    if (window.createImageBitmap) return window.createImageBitmap(file);
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Imagem inválida"));
      };
      image.src = url;
    });
  }

  async function optimizeImage(file) {
    const accepted = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    if (!accepted.has(file.type)) throw new Error("Use uma imagem PNG, JPG, WebP ou GIF.");
    if (file.size > MAX_SOURCE_IMAGE_BYTES) throw new Error("A imagem original deve ter no máximo 8 MB.");

    const bitmap = await loadBitmap(file);
    const maxDimension = 720;
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("O navegador não conseguiu processar a imagem.");
    context.fillStyle = "#0e1114";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (typeof bitmap.close === "function") bitmap.close();

    let blob = await canvasBlob(canvas, "image/webp", .78).catch(() => canvasBlob(canvas, "image/jpeg", .8));
    if (blob.size > MAX_STORED_IMAGE_BYTES) blob = await canvasBlob(canvas, "image/webp", .62).catch(() => canvasBlob(canvas, "image/jpeg", .65));
    if (blob.size > MAX_STORED_IMAGE_BYTES) throw new Error("A imagem continuou muito grande após a redução. Escolha outra imagem.");
    return blob;
  }

  function validateForm() {
    let firstInvalid = null;
    const requiredText = [elements.name, elements.category];
    requiredText.forEach((field) => {
      const invalid = !normalizeWhitespace(field.value, field.maxLength || 80);
      field.toggleAttribute("aria-invalid", invalid);
      if (invalid && !firstInvalid) firstInvalid = field;
    });

    const minimumValue = elements.minimum.value.trim();
    const minimum = Number(minimumValue);
    const minimumInvalid = minimumValue !== ""
      && (!Number.isFinite(minimum) || minimum < 0 || minimum > 1_000_000_000);
    elements.minimum.toggleAttribute("aria-invalid", minimumInvalid);
    if (minimumInvalid && !firstInvalid) firstInvalid = elements.minimum;

    const quantityValue = elements.quantity.value.trim();
    const quantity = Number(quantityValue);
    const quantityInvalid = quantityValue !== ""
      && (!Number.isFinite(quantity) || quantity < 0 || quantity > 1_000_000_000);
    elements.quantity.toggleAttribute("aria-invalid", quantityInvalid);
    if (quantityInvalid && !firstInvalid) firstInvalid = elements.quantity;

    const cost = elements.unitCost.value === "" ? 0 : Number(elements.unitCost.value);
    const costInvalid = !Number.isFinite(cost) || cost < 0 || cost > 1_000_000_000;
    elements.unitCost.toggleAttribute("aria-invalid", costInvalid);
    if (costInvalid && !firstInvalid) firstInvalid = elements.unitCost;

    const datasheetUrlValue = normalizeWhitespace(elements.datasheetUrl.value, 500);
    const datasheetUrlInvalid = Boolean(datasheetUrlValue) && !normalizeDatasheetUrl(datasheetUrlValue);
    elements.datasheetUrl.setCustomValidity(datasheetUrlInvalid ? "Use um endereço completo iniciado por http:// ou https://." : "");
    elements.datasheetUrl.toggleAttribute("aria-invalid", datasheetUrlInvalid);
    if (datasheetUrlInvalid && !firstInvalid) firstInvalid = elements.datasheetUrl;

    const sku = normalizeSearch(elements.sku.value);
    const duplicate = sku && items.some((item) => item.id !== elements.id.value && normalizeSearch(item.sku) === sku);
    elements.sku.setCustomValidity(duplicate ? "Este código já está cadastrado." : "");
    elements.sku.toggleAttribute("aria-invalid", Boolean(duplicate));
    if (duplicate && !firstInvalid) firstInvalid = elements.sku;

    if (firstInvalid) {
      firstInvalid.focus();
      firstInvalid.reportValidity?.();
      notify(duplicate
        ? "Já existe um componente com esse código."
        : datasheetUrlInvalid
          ? "Revise o link do datasheet: ele deve começar com http:// ou https://."
          : "Revise os campos obrigatórios do componente.");
      return false;
    }
    return true;
  }

  async function saveForm(event) {
    event.preventDefault();
    if (pendingExternalInventoryUpdate) {
      notify("O estoque mudou em outra aba. Feche este formulário e abra o componente novamente.");
      return;
    }
    if (!validateForm()) return;

    elements.save.disabled = true;
    const current = items.find((item) => item.id === elements.id.value);
    const now = new Date().toISOString();
    const item = normalizeItem({
      id: current?.id ?? createId(),
      name: elements.name.value,
      sku: elements.sku.value,
      category: elements.category.value,
      quantity: elements.quantity.value,
      quantityKnown: elements.quantity.value.trim() !== "",
      unit: elements.unit.value,
      minimum: elements.minimum.value,
      minimumKnown: elements.minimum.value.trim() !== "",
      stockAlert: elements.lowStockOverride?.checked ? "low" : "",
      unitCost: elements.unitCost.value,
      unitCostKnown: elements.unitCost.value.trim() !== "",
      manufacturer: elements.manufacturer.value,
      location: elements.location.value,
      notes: elements.notes.value,
      hasImage: draftImageBlob instanceof Blob ? true : draftImageBlob === null ? false : Boolean(current?.hasImage),
      datasheetUrl: elements.datasheetUrl.value,
      hasDatasheet: draftDatasheetBlob instanceof Blob ? true : draftDatasheetBlob === null ? false : Boolean(current?.hasDatasheet),
      datasheetName: draftDatasheetBlob instanceof Blob
        ? draftDatasheetMetadata?.fileName
        : draftDatasheetBlob === null ? "" : current?.datasheetName,
      datasheetSize: draftDatasheetBlob instanceof Blob
        ? draftDatasheetMetadata?.size
        : draftDatasheetBlob === null ? 0 : current?.datasheetSize,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    });

    if (!item) {
      elements.save.disabled = false;
      notify("Não foi possível validar o componente.");
      return;
    }

    const imageChangeRequested = draftImageBlob instanceof Blob || draftImageBlob === null;
    const datasheetChangeRequested = draftDatasheetBlob instanceof Blob || draftDatasheetBlob === null;
    let previousImage = null;
    let previousDatasheet = null;
    let imageChanged = false;
    let datasheetChanged = false;

    const rollbackAssets = async () => {
      try {
        if (imageChanged) {
          if (previousImage instanceof Blob) await putImage(item.id, previousImage);
          else await deleteImage(item.id);
        }
        if (datasheetChanged) {
          if (previousDatasheet?.blob instanceof Blob) await putDatasheet(item.id, previousDatasheet.blob, previousDatasheet);
          else await deleteDatasheet(item.id);
        }
      } catch (error) {
        console.error("Falha ao restaurar anexos após cancelamento:", error);
      }
    };

    try {
      if (imageChangeRequested && current?.hasImage) previousImage = await getImage(item.id);
      if (datasheetChangeRequested && current?.hasDatasheet) previousDatasheet = await getDatasheet(item.id);
      if (draftImageBlob instanceof Blob) {
        await putImage(item.id, draftImageBlob);
        imageChanged = true;
      } else if (draftImageBlob === null && current?.hasImage) {
        await deleteImage(item.id);
        imageChanged = true;
      }
      if (draftDatasheetBlob instanceof Blob) {
        await putDatasheet(item.id, draftDatasheetBlob, draftDatasheetMetadata);
        datasheetChanged = true;
      } else if (draftDatasheetBlob === null && current?.hasDatasheet) {
        await deleteDatasheet(item.id);
        datasheetChanged = true;
      }
    } catch (error) {
      await rollbackAssets();
      console.error("Falha ao salvar imagem ou datasheet:", error);
      elements.save.disabled = false;
      notify("Não foi possível salvar os anexos. O cadastro anterior foi mantido.");
      return;
    }

    if (pendingExternalInventoryUpdate) {
      await rollbackAssets();
      elements.save.disabled = true;
      notify("O estoque mudou em outra aba durante o salvamento. Feche o formulário e tente novamente.");
      return;
    }

    const nextItems = current
      ? items.map((candidate) => candidate.id === item.id ? item : candidate)
      : [item, ...items];

    if (!persistInventory(nextItems)) {
      await rollbackAssets();
      elements.save.disabled = false;
      return;
    }

    elements.save.disabled = false;
    closeInventoryModal({ restoreFocus: false });
    renderInventory();
    requestAnimationFrame(() => {
      elements.list.querySelector(`[data-inventory-id="${CSS.escape(item.id)}"] [data-action="edit"]`)?.focus();
    });
    notify(current ? "Componente atualizado." : "Componente adicionado ao estoque.");
  }

  function adjustQuantity(id, delta) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    if (item.quantityKnown === false && delta < 0) return;
    const action = delta > 0 ? "increment" : "decrement";
    const quantity = item.quantityKnown === false && delta > 0
      ? 1
      : finiteNumber(item.quantity + delta, item.quantity);
    const nextItems = items.map((candidate) => candidate.id === id
      ? { ...candidate, quantity, quantityKnown: true, updatedAt: new Date().toISOString() }
      : candidate);
    if (persistInventory(nextItems)) {
      renderInventory();
      requestAnimationFrame(() => {
        elements.list.querySelector(`[data-inventory-id="${CSS.escape(id)}"] [data-action="${action}"]`)?.focus();
      });
    }
  }

  function openExternalDatasheet(url, previewWindow = null) {
    const safeUrl = normalizeDatasheetUrl(url);
    if (!safeUrl) return false;
    if (previewWindow) {
      previewWindow.location.replace(safeUrl);
      return true;
    }
    const anchor = document.createElement("a");
    anchor.href = safeUrl;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return true;
  }

  async function openDatasheet(id) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    const previewWindow = item.hasDatasheet ? window.open("about:blank", "_blank") : null;
    if (previewWindow) {
      previewWindow.opener = null;
      previewWindow.document.title = "Carregando datasheet…";
      previewWindow.document.body.textContent = "Carregando datasheet…";
    }
    if (item.hasDatasheet && imageDatabaseAvailable) {
      try {
        const record = await getDatasheet(id);
        if (record?.blob) {
          const url = URL.createObjectURL(record.blob);
          if (previewWindow) previewWindow.location.replace(url);
          else {
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.target = "_blank";
            anchor.rel = "noopener";
            anchor.title = record.fileName || item.datasheetName || "Datasheet";
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
          }
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          return;
        }
      } catch (error) {
        console.error("Falha ao abrir datasheet local:", error);
      }
      if (!item.datasheetUrl) {
        previewWindow?.close();
        notify("O PDF deste componente não foi encontrado neste navegador.");
        return;
      }
    }
    if (!openExternalDatasheet(item.datasheetUrl, previewWindow)) {
      previewWindow?.close();
      notify("Este componente ainda não possui um datasheet disponível.");
    }
  }

  async function removeItem(id) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    if (!window.confirm(`Excluir “${item.name}” do estoque? Esta ação não pode ser desfeita.`)) return;
    const nextItems = items.filter((candidate) => candidate.id !== id);
    if (!persistInventory(nextItems)) return;
    let cleanupFailed = false;
    const cleanupOperations = [];
    if (item.hasImage) cleanupOperations.push({ label: "imagem", run: () => deleteImage(id) });
    if (item.hasDatasheet) cleanupOperations.push({ label: "datasheet", run: () => deleteDatasheet(id) });
    for (const operation of cleanupOperations) {
      try {
        await operation.run();
      } catch (firstError) {
        await new Promise((resolve) => setTimeout(resolve, 75));
        try {
          await operation.run();
        } catch (secondError) {
          cleanupFailed = true;
          console.warn(`Falha ao excluir ${operation.label} após nova tentativa:`, secondError ?? firstError);
        }
      }
    }
    renderInventory();
    notify(cleanupFailed
      ? "Componente excluído; um anexo local não pôde ser removido do armazenamento."
      : "Componente e anexos excluídos do estoque.");
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error ?? new Error("Falha ao ler anexo"));
      reader.readAsDataURL(blob);
    });
  }

  async function buildExportDocument() {
    const images = {};
    const datasheets = {};
    let imageFailures = 0;
    let datasheetFailures = 0;
    if (imageDatabaseAvailable) {
      await Promise.all(items.filter((item) => item.hasImage).map(async (item) => {
        try {
          const blob = await getImage(item.id);
          if (blob) images[item.id] = await blobToDataUrl(blob);
          else imageFailures += 1;
        } catch (error) {
          imageFailures += 1;
          console.warn(`Imagem ${item.id} não incluída no backup:`, error);
        }
      }));
    } else {
      imageFailures = items.filter((item) => item.hasImage).length;
    }
    if (imageDatabaseAvailable) {
      await Promise.all(items.filter((item) => item.hasDatasheet).map(async (item) => {
        try {
          const record = await getDatasheet(item.id);
          if (record?.blob) {
            datasheets[item.id] = {
              fileName: normalizeWhitespace(record.fileName ?? item.datasheetName, 120) || "datasheet.pdf",
              mimeType: "application/pdf",
              size: record.blob.size,
              data: await blobToDataUrl(record.blob)
            };
          } else datasheetFailures += 1;
        } catch (error) {
          datasheetFailures += 1;
          console.warn(`Datasheet ${item.id} não incluído no backup:`, error);
        }
      }));
    } else {
      datasheetFailures = items.filter((item) => item.hasDatasheet).length;
    }
    return {
      imageFailures,
      datasheetFailures,
      documentValue: {
        format: EXPORT_FORMAT,
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        itemCount: items.length,
        items,
        images,
        datasheets
      }
    };
  }

  async function exportJson() {
    elements.exportButton.disabled = true;
    elements.exportButton.textContent = "Preparando…";
    try {
      const backup = await buildExportDocument();
      let json = JSON.stringify(backup.documentValue, null, 2);
      let blob = new Blob([json], { type: "application/json;charset=utf-8" });
      let attachmentsOmittedForSize = 0;
      if (blob.size > MAX_IMPORT_BYTES) {
        const generateWithoutAttachments = window.confirm(
          "O backup com imagens e datasheets ultrapassa 50 MB e não poderia ser reimportado por esta versão.\n\nGerar agora um backup dos cadastros sem os anexos?"
        );
        if (!generateWithoutAttachments) {
          notify("Backup cancelado. Reduza ou remova alguns anexos antes de tentar novamente.");
          return;
        }
        attachmentsOmittedForSize = Object.keys(backup.documentValue.images).length
          + Object.keys(backup.documentValue.datasheets).length;
        backup.documentValue.images = {};
        backup.documentValue.datasheets = {};
        backup.documentValue.attachmentsOmitted = true;
        json = JSON.stringify(backup.documentValue, null, 2);
        blob = new Blob([json], { type: "application/json;charset=utf-8" });
      }
      const date = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `estoque-ufpr-formula-${date}.json`);
      const missingAttachments = backup.imageFailures + backup.datasheetFailures + attachmentsOmittedForSize;
      notify(missingAttachments > 0
        ? `Backup gerado com ${items.length} componentes; ${missingAttachments} anexos não foram incluídos.`
        : `Backup completo gerado com ${items.length} componentes, imagens e datasheets.`);
    } catch (error) {
      console.error("Falha ao gerar backup do estoque:", error);
      notify("Não foi possível gerar o Backup JSON. Tente novamente ou remova anexos muito grandes.");
    } finally {
      elements.exportButton.disabled = false;
      elements.exportButton.textContent = "Backup JSON";
    }
  }

  const excelReportColors = {
    background: "FF0B0E10",
    panel: "FF171C20",
    panelAlt: "FF22292D",
    accent: "FFDEFF47",
    text: "FFF1F4F5",
    muted: "FF99A6AD",
    line: "FF3A454B",
    green: "FF6FE79A",
    greenSoft: "FFE2F6E9",
    orange: "FFFFB454",
    orangeSoft: "FFFFE8C7",
    red: "FFFF626A",
    redSoft: "FFFFDADC",
    blue: "FF4AA8FF",
    gray: "FF66737A",
    graySoft: "FFE8ECEE"
  };

  function reportTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
  }

  function reportDate(value) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : "";
  }

  function reportStatusStyle(status) {
    if (status === "out") return { foreground: excelReportColors.red, background: excelReportColors.redSoft };
    if (status === "low") return { foreground: "FF8A4F00", background: excelReportColors.orangeSoft };
    if (status === "unknown") return { foreground: excelReportColors.gray, background: excelReportColors.graySoft };
    return { foreground: "FF166534", background: excelReportColors.greenSoft };
  }

  function applyReportTitle(worksheet, title, subtitle, lastColumn) {
    worksheet.mergeCells(`A1:${lastColumn}1`);
    worksheet.mergeCells(`A2:${lastColumn}2`);
    const titleCell = worksheet.getCell("A1");
    const subtitleCell = worksheet.getCell("A2");
    titleCell.value = title;
    titleCell.font = { name: "Aptos Display", size: 19, bold: true, color: { argb: excelReportColors.text } };
    titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: excelReportColors.background } };
    titleCell.alignment = { vertical: "middle", horizontal: "left" };
    titleCell.border = { left: { style: "thick", color: { argb: excelReportColors.accent } } };
    subtitleCell.value = subtitle;
    subtitleCell.font = { name: "Aptos", size: 10, color: { argb: excelReportColors.muted } };
    subtitleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: excelReportColors.background } };
    subtitleCell.alignment = { vertical: "middle", horizontal: "left" };
    subtitleCell.border = { left: { style: "thick", color: { argb: excelReportColors.accent } } };
    worksheet.getRow(1).height = 31;
    worksheet.getRow(2).height = 23;
  }

  function addReportTable(worksheet, { name, startRow = 4, columns, rows, widths }) {
    const table = worksheet.addTable({
      name,
      ref: `A${startRow}`,
      headerRow: true,
      totalsRow: false,
      style: {
        theme: "TableStyleMedium4",
        showFirstColumn: false,
        showLastColumn: false,
        showRowStripes: true,
        showColumnStripes: false
      },
      columns: columns.map((column) => ({ name: column, filterButton: true })),
      rows
    });
    table.commit();

    widths.forEach((width, index) => {
      worksheet.getColumn(index + 1).width = width;
    });

    const header = worksheet.getRow(startRow);
    header.height = 28;
    header.eachCell((cell) => {
      cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: excelReportColors.accent } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: excelReportColors.panel } };
      cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
      cell.border = { bottom: { style: "medium", color: { argb: excelReportColors.accent } } };
    });

    const firstDataRow = startRow + 1;
    const lastDataRow = startRow + rows.length;
    for (let rowNumber = firstDataRow; rowNumber <= lastDataRow; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      row.height = 22;
      row.eachCell((cell) => {
        cell.font = { name: "Aptos", size: 10, color: { argb: "FF273138" } };
        cell.alignment = { vertical: "middle", horizontal: "left" };
        cell.border = { bottom: { style: "hair", color: { argb: "FFD6DCE0" } } };
      });
    }

    worksheet.views = [{ state: "frozen", ySplit: startRow, activeCell: `A${firstDataRow}`, showGridLines: false }];
    worksheet.pageSetup = {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
    };
    return { firstDataRow, lastDataRow };
  }

  function styleStatusColumn(worksheet, sourceItems, firstDataRow, columnNumber) {
    sourceItems.forEach((item, index) => {
      const colors = reportStatusStyle(stockState(item));
      const cell = worksheet.getCell(firstDataRow + index, columnNumber);
      cell.font = { name: "Aptos", size: 9, bold: true, color: { argb: colors.foreground } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.background } };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });
  }

  function addSummaryKpi(worksheet, range, value, label, color = excelReportColors.accent) {
    worksheet.mergeCells(range);
    const cell = worksheet.getCell(range.split(":")[0]);
    cell.value = {
      richText: [
        { text: String(value), font: { name: "Aptos Display", size: 20, bold: true, color: { argb: color } } },
        { text: `\n${label}`, font: { name: "Aptos", size: 9, bold: true, color: { argb: excelReportColors.muted } } }
      ]
    };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: excelReportColors.panel } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: excelReportColors.line } },
      left: { style: "thin", color: { argb: excelReportColors.line } },
      bottom: { style: "thin", color: { argb: excelReportColors.line } },
      right: { style: "thin", color: { argb: excelReportColors.line } }
    };
  }

  function renderXlsxButtonLabel(busy) {
    if (!elements.xlsxButton) return;
    elements.xlsxButton.replaceChildren();
    if (busy) {
      elements.xlsxButton.textContent = "Gerando Excel…";
      return;
    }
    const badge = document.createElement("span");
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = "XLSX";
    elements.xlsxButton.append(badge, document.createTextNode(" Relatório Excel"));
  }

  async function exportXlsx() {
    if (!elements.xlsxButton) return;
    if (items.length === 0) {
      notify("Cadastre ao menos um componente antes de gerar o relatório Excel.");
      return;
    }
    if (!window.ExcelJS?.Workbook) {
      notify("O módulo local de relatórios Excel não foi carregado. Reabra a versão completa do software.");
      return;
    }

    elements.xlsxButton.disabled = true;
    elements.xlsxButton.setAttribute("aria-busy", "true");
    renderXlsxButtonLabel(true);

    try {
      const generatedAt = new Date();
      const generatedLabel = generatedAt.toLocaleString("pt-BR");
      const workbook = new window.ExcelJS.Workbook();
      workbook.creator = "UFPR Formula Telemetria-EV";
      workbook.lastModifiedBy = "Banco de dados de componentes";
      workbook.created = generatedAt;
      workbook.modified = generatedAt;
      workbook.subject = "Levantamento visual do estoque de componentes do carro";
      workbook.title = "Relatório de estoque — UFPR Formula";
      workbook.company = "UFPR Formula";
      workbook.calcProperties.fullCalcOnLoad = true;

      const statusOrder = { out: 0, low: 1, unknown: 2, available: 3 };
      const reportItems = [...items].sort((left, right) => (
        statusOrder[stockState(left)] - statusOrder[stockState(right)]
        || left.category.localeCompare(right.category, "pt-BR")
        || left.name.localeCompare(right.name, "pt-BR")
      ));
      const availableCount = items.filter((item) => stockState(item) === "available").length;
      const lowCount = items.filter((item) => stockState(item) === "low").length;
      const outCount = items.filter((item) => stockState(item) === "out").length;
      const unknownCount = items.filter((item) => stockState(item) === "unknown").length;
      const categoryTotal = new Set(items.map((item) => item.category)).size;
      const valuedItems = items.filter((item) => item.quantityKnown !== false && item.unitCostKnown !== false);
      const inventoryValue = valuedItems
        .reduce((total, item) => total + (item.quantity * item.unitCost), 0);

      const summary = workbook.addWorksheet("Resumo", {
        properties: { tabColor: { argb: excelReportColors.accent } },
        views: [{ showGridLines: false }]
      });
      summary.columns = Array.from({ length: 8 }, () => ({ width: 15 }));
      applyReportTitle(
        summary,
        "UFPR FORMULA · CONTROLE DE ESTOQUE",
        `Relatório gerado em ${generatedLabel} · fonte: banco de dados local do software`,
        "H"
      );
      addSummaryKpi(summary, "A4:B6", items.length, "SKUs CADASTRADOS");
      addSummaryKpi(summary, "C4:D6", availableCount, "DISPONÍVEIS", excelReportColors.green);
      addSummaryKpi(summary, "E4:F6", lowCount, "ESTOQUE BAIXO", excelReportColors.orange);
      addSummaryKpi(summary, "G4:H6", outCount, "ESGOTADOS", excelReportColors.red);
      addSummaryKpi(summary, "A8:C10", valuedItems.length > 0 ? formatCurrency(inventoryValue) : "NÃO INFORMADO", "VALOR TOTAL ESTIMADO");
      addSummaryKpi(summary, "D8:F10", categoryTotal, "TIPOS DE COMPONENTE", excelReportColors.blue);
      addSummaryKpi(summary, "G8:H10", unknownCount, "SEM CONTAGEM · REVISAR", excelReportColors.gray);
      summary.mergeCells("A12:H12");
      summary.getCell("A12").value = "QUANTIDADES SEPARADAS POR UNIDADE";
      summary.getCell("A12").font = { name: "Aptos", size: 10, bold: true, color: { argb: excelReportColors.text } };
      summary.getCell("A12").fill = { type: "pattern", pattern: "solid", fgColor: { argb: excelReportColors.panelAlt } };
      summary.getCell("A12").alignment = { vertical: "middle", horizontal: "left" };
      summary.getRow(12).height = 24;

      const totalsByUnit = new Map();
      items.filter((item) => item.quantityKnown !== false)
        .forEach((item) => totalsByUnit.set(item.unit, (totalsByUnit.get(item.unit) ?? 0) + item.quantity));
      const unitRows = Array.from(totalsByUnit, ([unit, total]) => [unitLabels[unit] ?? unit, total])
        .sort((left, right) => left[0].localeCompare(right[0], "pt-BR"));
      const unitTable = addReportTable(summary, {
        name: "TabelaResumoUnidades",
        startRow: 13,
        columns: ["Unidade", "Quantidade em estoque"],
        rows: unitRows.length > 0 ? unitRows : [["Sem quantidades contadas", ""]],
        widths: [24, 24]
      });
      summary.views = [{ state: "frozen", ySplit: 2, activeCell: "A3", showGridLines: false }];
      summary.getColumn(2).numFmt = "#,##0.00";
      const summaryNoteRow = Math.max(17, unitTable.lastDataRow + 2);
      summary.mergeCells(`A${summaryNoteRow}:H${summaryNoteRow + 2}`);
      const summaryNote = summary.getCell(`A${summaryNoteRow}`);
      summaryNote.value = `Este arquivo é um relatório independente. ${unknownCount} cadastro(s) estão sem contagem e precisam de revisão manual. Alterações feitas no Excel não retornam ao software. Para restaurar ou transferir o estoque, use o Backup JSON da aba Banco de dados.`;
      summaryNote.font = { name: "Aptos", size: 10, italic: true, color: { argb: excelReportColors.muted } };
      summaryNote.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F3F4" } };
      summaryNote.alignment = { vertical: "middle", horizontal: "left", wrapText: true };

      const inventorySheet = workbook.addWorksheet("Estoque", {
        properties: { tabColor: { argb: excelReportColors.green } },
        views: [{ showGridLines: false }]
      });
      applyReportTitle(
        inventorySheet,
        "ESTOQUE COMPLETO",
        `Todos os componentes · filtros disponíveis nos cabeçalhos · gerado em ${generatedLabel}`,
        "T"
      );
      const inventoryRows = reportItems.map((item) => {
        const hasCount = item.quantityKnown !== false;
        const hasMinimum = item.minimumKnown !== false;
        const hasCost = item.unitCostKnown !== false;
        const deficit = hasCount && hasMinimum ? Math.max(0, item.minimum - item.quantity) : "";
        const datasheetType = item.hasDatasheet && item.datasheetUrl
          ? "PDF + link"
          : item.hasDatasheet
            ? "PDF anexado"
            : item.datasheetUrl
              ? "Link externo"
              : "Não informado";
        return [
          stockStatusLabel(item), item.sku, item.name, item.category, item.manufacturer, item.location,
          hasCount ? item.quantity : "", unitLabels[item.unit] ?? item.unit, hasMinimum ? item.minimum : "",
          hasCount && hasMinimum ? item.quantity - item.minimum : "", deficit, hasCost ? item.unitCost : "",
          hasCount && hasCost ? item.quantity * item.unitCost : "", item.hasImage ? "Sim" : "Não",
          datasheetType, item.hasDatasheet ? item.datasheetName || "PDF anexado" : "",
          item.datasheetUrl ? "Abrir link" : "", item.notes,
          reportDate(item.createdAt), reportDate(item.updatedAt)
        ];
      });
      const inventoryTable = addReportTable(inventorySheet, {
        name: "TabelaEstoqueUFPR",
        columns: [
          "Situação", "Código / PN", "Componente", "Tipo", "Fabricante", "Localização",
          "Quantidade", "Unidade", "Estoque mínimo", "Saldo vs. mínimo", "Déficit para mínimo",
          "Custo unitário (R$)", "Valor em estoque (R$)", "Imagem", "Datasheet",
          "Nome do PDF", "Link do datasheet", "Observações", "Criado em", "Atualizado em"
        ],
        rows: inventoryRows,
        widths: [17, 18, 28, 22, 22, 22, 13, 11, 15, 16, 18, 18, 20, 11, 16, 28, 18, 38, 19, 19]
      });
      styleStatusColumn(inventorySheet, reportItems, inventoryTable.firstDataRow, 1);
      [7, 9, 10, 11].forEach((column) => { inventorySheet.getColumn(column).numFmt = "#,##0.00"; });
      [12, 13].forEach((column) => { inventorySheet.getColumn(column).numFmt = '"R$" #,##0.00'; });
      [19, 20].forEach((column) => { inventorySheet.getColumn(column).numFmt = "dd/mm/yyyy hh:mm"; });
      inventorySheet.getColumn(18).alignment = { vertical: "top", horizontal: "left", wrapText: true };
      reportItems.forEach((item, index) => {
        if (!item.datasheetUrl) return;
        const cell = inventorySheet.getCell(inventoryTable.firstDataRow + index, 17);
        cell.value = { text: "Abrir link", hyperlink: item.datasheetUrl, tooltip: item.datasheetUrl };
        cell.font = { name: "Aptos", size: 10, color: { argb: excelReportColors.blue }, underline: true };
      });

      const replenishmentSheet = workbook.addWorksheet("Reposição", {
        properties: { tabColor: { argb: excelReportColors.red } },
        views: [{ showGridLines: false }]
      });
      applyReportTitle(
        replenishmentSheet,
        "LISTA DE REPOSIÇÃO",
        "Itens esgotados ou no limite mínimo configurado · cadastros sem contagem ficam fora desta reposição automática",
        "K"
      );
      const replenishmentItems = reportItems.filter((item) => ["out", "low"].includes(stockState(item)));
      if (replenishmentItems.length > 0) {
        const replenishmentRows = replenishmentItems.map((item) => {
          const hasMinimum = item.minimumKnown !== false;
          const hasCost = item.unitCostKnown !== false;
          const deficit = hasMinimum ? Math.max(0, item.minimum - item.quantity) : "";
          return [
            stockStatusLabel(item), item.sku, item.name, item.category, item.manufacturer, item.location,
            item.quantity, unitLabels[item.unit] ?? item.unit, hasMinimum ? item.minimum : "", deficit,
            hasMinimum && hasCost ? deficit * item.unitCost : ""
          ];
        });
        const replenishmentTable = addReportTable(replenishmentSheet, {
          name: "TabelaReposicaoUFPR",
          columns: [
            "Situação", "Código / PN", "Componente", "Tipo", "Fabricante", "Localização",
            "Quantidade", "Unidade", "Estoque mínimo", "Déficit para mínimo", "Custo estimado (R$)"
          ],
          rows: replenishmentRows,
          widths: [17, 18, 28, 22, 22, 22, 13, 11, 15, 18, 20]
        });
        styleStatusColumn(replenishmentSheet, replenishmentItems, replenishmentTable.firstDataRow, 1);
        [7, 9, 10].forEach((column) => { replenishmentSheet.getColumn(column).numFmt = "#,##0.00"; });
        replenishmentSheet.getColumn(11).numFmt = '"R$" #,##0.00';
      } else {
        replenishmentSheet.mergeCells("A4:K7");
        const emptyCell = replenishmentSheet.getCell("A4");
        emptyCell.value = unknownCount > 0
          ? `Nenhum componente precisa de reposição automática. ${unknownCount} cadastro(s) sem contagem aparecem na planilha Estoque para revisão manual.`
          : "Nenhum componente precisa de reposição neste levantamento.";
        emptyCell.font = { name: "Aptos", size: 14, bold: true, color: { argb: "FF166534" } };
        emptyCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: excelReportColors.greenSoft } };
        emptyCell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        replenishmentSheet.columns = Array.from({ length: 11 }, () => ({ width: 16 }));
      }

      const categorySheet = workbook.addWorksheet("Por tipo", {
        properties: { tabColor: { argb: excelReportColors.blue } },
        views: [{ showGridLines: false }]
      });
      applyReportTitle(
        categorySheet,
        "RESUMO POR TIPO DE COMPONENTE",
        "Quantidade de cadastros, situação e valor estimado agrupados por tipo",
        "G"
      );
      const categories = new Map();
      items.forEach((item) => {
        const aggregate = categories.get(item.category) ?? { total: 0, available: 0, low: 0, out: 0, unknown: 0, value: 0, valued: 0 };
        const status = stockState(item);
        aggregate.total += 1;
        aggregate[status] += 1;
        if (item.quantityKnown !== false && item.unitCostKnown !== false) {
          aggregate.value += item.quantity * item.unitCost;
          aggregate.valued += 1;
        }
        categories.set(item.category, aggregate);
      });
      const categoryRows = Array.from(categories, ([category, aggregate]) => [
        category, aggregate.total, aggregate.available, aggregate.low, aggregate.out, aggregate.unknown,
        aggregate.valued > 0 ? aggregate.value : ""
      ]).sort((left, right) => left[0].localeCompare(right[0], "pt-BR"));
      addReportTable(categorySheet, {
        name: "TabelaTiposUFPR",
        columns: ["Tipo", "SKUs", "Disponíveis", "Estoque baixo", "Esgotados", "Sem contagem", "Valor estimado (R$)"],
        rows: categoryRows,
        widths: [30, 12, 15, 17, 14, 16, 22]
      });
      [2, 3, 4, 5, 6].forEach((column) => { categorySheet.getColumn(column).numFmt = "0"; });
      categorySheet.getColumn(7).numFmt = '"R$" #,##0.00';

      workbook.views = [{ activeTab: 0, visibility: "visible" }];
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      });
      downloadBlob(blob, `relatorio-estoque-ufpr-${reportTimestamp(generatedAt)}.xlsx`);
      notify(`Relatório Excel gerado: ${items.length} componentes, ${replenishmentItems.length} para reposição e ${unknownCount} sem contagem para revisão.`);
    } catch (error) {
      console.error("Falha ao gerar relatório Excel:", error);
      notify("Não foi possível gerar o relatório Excel. O CSV simples continua disponível.");
    } finally {
      elements.xlsxButton.disabled = false;
      elements.xlsxButton.removeAttribute("aria-busy");
      renderXlsxButtonLabel(false);
    }
  }

  function safeCsvCell(value) {
    let text = String(value ?? "").replace(/\r?\n/g, " ");
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportCsv() {
    const headers = ["Situação", "Código", "Nome", "Tipo", "Fabricante", "Localização", "Quantidade", "Unidade", "Estoque mínimo", "Custo unitário (R$)", "Valor em estoque (R$)", "Datasheet", "Atualizado em"];
    const rows = items.map((item) => [
      stockStatusLabel(item),
      item.sku,
      item.name,
      item.category,
      item.manufacturer,
      item.location,
      item.quantityKnown === false ? "" : String(item.quantity).replace(".", ","),
      unitLabels[item.unit],
      item.minimumKnown === false ? "" : String(item.minimum).replace(".", ","),
      item.unitCostKnown === false ? "" : item.unitCost.toFixed(2).replace(".", ","),
      item.quantityKnown === false || item.unitCostKnown === false ? "" : (item.unitCost * item.quantity).toFixed(2).replace(".", ","),
      item.hasDatasheet ? item.datasheetName || "PDF anexado" : item.datasheetUrl,
      new Date(item.updatedAt).toLocaleString("pt-BR")
    ]);
    const csv = [headers, ...rows].map((row) => row.map(safeCsvCell).join(";")).join("\r\n");
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }), `levantamento-estoque-ufpr-${date}.csv`);
    const unknownCount = items.filter((item) => item.quantityKnown === false).length;
    notify(`Relatório CSV gerado${unknownCount > 0 ? ` com ${unknownCount} cadastro(s) sem contagem sinalizado(s)` : ""}.`);
  }

  function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== "string" || !/^data:image\/(png|jpeg|webp);base64,/i.test(dataUrl)) return null;
    const [header, encoded] = dataUrl.split(",", 2);
    try {
      const binary = atob(encoded);
      if (binary.length > MAX_STORED_IMAGE_BYTES) return null;
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new Blob([bytes], { type: header.slice(5, header.indexOf(";")) });
    } catch {
      return null;
    }
  }

  function dataUrlToDatasheet(rawRecord) {
    const record = typeof rawRecord === "string" ? { data: rawRecord } : rawRecord;
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    if (typeof record.data !== "string" || !/^data:application\/pdf;base64,/i.test(record.data)) return null;
    const encoded = record.data.slice(record.data.indexOf(",") + 1);
    try {
      const binary = atob(encoded);
      if (binary.length <= 0 || binary.length > MAX_DATASHEET_BYTES || !binary.startsWith("%PDF-")) return null;
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const fileName = normalizeWhitespace(record.fileName, 120);
      return {
        blob: new Blob([bytes], { type: "application/pdf" }),
        metadata: {
          fileName: fileName.toLocaleLowerCase("pt-BR").endsWith(".pdf") ? fileName : "datasheet.pdf",
          size: binary.length,
          mimeType: "application/pdf"
        }
      };
    } catch {
      return null;
    }
  }

  async function importJson(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      notify("O arquivo de importação deve ter no máximo 50 MB.");
      return;
    }

    try {
      const parsed = JSON.parse(await file.text());
      const rawItems = Array.isArray(parsed) ? parsed : parsed?.items;
      if (!Array.isArray(rawItems) || rawItems.length > MAX_ITEMS) throw new Error("Lista de componentes inválida ou muito grande");
      if (!Array.isArray(parsed) && parsed.format && parsed.format !== EXPORT_FORMAT) throw new Error("Formato de backup desconhecido");
      if (!Array.isArray(parsed) && parsed.schemaVersion !== undefined && !SUPPORTED_SCHEMA_VERSIONS.has(parsed.schemaVersion)) {
        throw new Error("Versão do backup incompatível");
      }

      const importedRecords = rawItems.map((rawItem) => {
        const sourceId = normalizeWhitespace(rawItem?.id, 80);
        const item = normalizeItem({ ...rawItem, id: sourceId || createId() });
        return item ? { sourceId: sourceId || item.id, item } : null;
      }).filter(Boolean);
      if (importedRecords.length === 0 && rawItems.length > 0) throw new Error("Nenhum componente válido foi encontrado");

      const seenSourceIds = new Set();
      const seenSkus = new Set();
      const seenFingerprints = new Set();
      const cleanImported = importedRecords.filter(({ sourceId, item }) => {
        const skuKey = normalizeSearch(item.sku);
        const fingerprint = inventoryFingerprint(item);
        if (seenSourceIds.has(sourceId) || (skuKey && seenSkus.has(skuKey)) || (!skuKey && seenFingerprints.has(fingerprint))) return false;
        seenSourceIds.add(sourceId);
        if (skuKey) seenSkus.add(skuKey);
        else seenFingerprints.add(fingerprint);
        return true;
      });

      const replace = items.length === 0 || window.confirm(
        "Substituir todo o estoque atual pelo arquivo?\n\nOK: substituir.\nCancelar: manter o estoque atual e adicionar somente componentes novos."
      );

      let recordsToApply;
      if (replace) {
        try {
          localStorage.setItem(BACKUP_KEY, JSON.stringify({
            format: EXPORT_FORMAT,
            schemaVersion: SCHEMA_VERSION,
            revision,
            items,
            backedUpAt: new Date().toISOString()
          }));
        } catch {}
        recordsToApply = cleanImported;
      } else {
        const existingIds = new Set(items.map((item) => item.id));
        const existingSkus = new Set(items.map((item) => normalizeSearch(item.sku)).filter(Boolean));
        const existingFingerprints = new Set(items.map(inventoryFingerprint));
        recordsToApply = cleanImported.filter(({ sourceId, item }) => (
          !existingIds.has(sourceId)
          && (!item.sku || !existingSkus.has(normalizeSearch(item.sku)))
          && (item.sku || !existingFingerprints.has(inventoryFingerprint(item)))
        ));
      }

      if (!replace && recordsToApply.length === 0) {
        notify("Nenhum componente novo foi encontrado para adicionar.");
        return;
      }

      const availableSlots = replace ? MAX_ITEMS : MAX_ITEMS - items.length;
      if (recordsToApply.length > availableSlots) {
        throw new Error(`A importação ultrapassaria o limite de ${MAX_ITEMS} componentes`);
      }

      const reservedIds = new Set(replace ? [] : items.map((item) => item.id));
      const appliedRecords = recordsToApply.map(({ sourceId, item }) => {
        let freshId = sourceId || createId();
        while (reservedIds.has(freshId)) freshId = createId();
        reservedIds.add(freshId);
        return {
          sourceId,
          item: {
            ...item,
            id: freshId,
            hasImage: false,
            hasDatasheet: false,
            datasheetName: "",
            datasheetSize: 0
          }
        };
      });

      const imageMap = !Array.isArray(parsed)
        && parsed.images
        && typeof parsed.images === "object"
        && !Array.isArray(parsed.images)
        ? parsed.images
        : {};
      const datasheetMap = !Array.isArray(parsed)
        && parsed.datasheets
        && typeof parsed.datasheets === "object"
        && !Array.isArray(parsed.datasheets)
        ? parsed.datasheets
        : {};
      let imagesImported = 0;
      let datasheetsImported = 0;
      const stagedImageIds = [];
      const stagedDatasheetIds = [];
      if (imageDatabaseAvailable) {
        await Promise.all(appliedRecords.map(async (record) => {
          const blob = dataUrlToBlob(imageMap[record.sourceId]);
          if (!blob) return;
          try {
            await putImage(record.item.id, blob);
            record.item.hasImage = true;
            stagedImageIds.push(record.item.id);
            imagesImported += 1;
          } catch (error) {
            console.warn(`Imagem ${record.sourceId} ignorada durante a importação:`, error);
          }
        }));
        await Promise.all(appliedRecords.map(async (record) => {
          const datasheet = dataUrlToDatasheet(datasheetMap[record.sourceId]);
          if (!datasheet) return;
          try {
            await putDatasheet(record.item.id, datasheet.blob, datasheet.metadata);
            record.item.hasDatasheet = true;
            record.item.datasheetName = datasheet.metadata.fileName;
            record.item.datasheetSize = datasheet.metadata.size;
            stagedDatasheetIds.push(record.item.id);
            datasheetsImported += 1;
          } catch (error) {
            console.warn(`Datasheet ${record.sourceId} ignorado durante a importação:`, error);
          }
        }));
      }

      const appliedItems = appliedRecords.map((record) => record.item);
      const nextItems = replace ? appliedItems : [...items, ...appliedItems];
      if (!persistInventory(nextItems)) {
        await Promise.all(stagedImageIds.map((id) => deleteImage(id).catch(() => {})));
        await Promise.all(stagedDatasheetIds.map((id) => deleteDatasheet(id).catch(() => {})));
        return;
      }

      renderInventory();
      notify(`${appliedItems.length} componentes, ${imagesImported} imagens e ${datasheetsImported} datasheets importados.`);
    } catch (error) {
      console.error("Falha na importação:", error);
      notify(`Não foi possível importar: ${error.message}`);
    } finally {
      elements.importInput.value = "";
    }
  }

  elements.add.addEventListener("click", (event) => openInventoryModal(null, event.currentTarget));
  elements.emptyAdd.addEventListener("click", (event) => {
    if (event.currentTarget.dataset.action === "clear-filters") clearFilters();
    else openInventoryModal(null, event.currentTarget);
  });
  elements.close.addEventListener("click", closeInventoryModal);
  elements.cancel.addEventListener("click", closeInventoryModal);
  elements.form.addEventListener("submit", saveForm);

  elements.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderInventory, 120);
  });
  elements.categoryFilter.addEventListener("change", renderInventory);
  elements.stockFilter.addEventListener("change", renderInventory);
  elements.sort.addEventListener("change", renderInventory);

  elements.list.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    const card = event.target.closest("[data-inventory-id]");
    if (!button || !card) return;
    const id = card.dataset.inventoryId;
    if (button.dataset.action === "increment") adjustQuantity(id, 1);
    if (button.dataset.action === "decrement") adjustQuantity(id, -1);
    if (button.dataset.action === "datasheet") openDatasheet(id);
    if (button.dataset.action === "edit") openInventoryModal(id, button);
    if (button.dataset.action === "delete") removeItem(id);
  });

  elements.imageInput.addEventListener("change", async () => {
    const [file] = elements.imageInput.files;
    if (!file) return;
    if (!imageDatabaseAvailable) {
      setImageStatus("O navegador não permite armazenar imagens nesta origem.", "error");
      elements.imageInput.value = "";
      return;
    }
    const previousDraftImage = draftImageBlob;
    setImageStatus("Reduzindo imagem…");
    try {
      const optimizedImage = await optimizeImage(file);
      draftImageBlob = optimizedImage;
      showDraftImage(draftImageBlob);
      setImageStatus(`Imagem pronta · ${Math.ceil(draftImageBlob.size / 1024)} KB`);
    } catch (error) {
      draftImageBlob = previousDraftImage;
      setImageStatus(error.message, "error");
      notify(error.message);
    } finally {
      elements.imageInput.value = "";
    }
  });

  elements.removeImage.addEventListener("click", () => {
    draftImageBlob = null;
    showDraftImage(null);
    setImageStatus("A imagem será removida ao salvar.");
  });

  elements.datasheetInput.addEventListener("change", async () => {
    const [file] = elements.datasheetInput.files;
    if (!file) return;
    if (!imageDatabaseAvailable) {
      showDraftDatasheet(draftDatasheetMetadata, "O navegador não permite armazenar anexos nesta origem.", "error");
      elements.datasheetInput.value = "";
      return;
    }
    const previousDraft = draftDatasheetBlob;
    const previousMetadata = draftDatasheetMetadata;
    showDraftDatasheet(previousMetadata, "Validando PDF…");
    try {
      const validated = await validateDatasheetFile(file);
      draftDatasheetBlob = validated.blob;
      draftDatasheetMetadata = validated.metadata;
      showDraftDatasheet(draftDatasheetMetadata, "pronto para salvar");
    } catch (error) {
      draftDatasheetBlob = previousDraft;
      draftDatasheetMetadata = previousMetadata;
      showDraftDatasheet(previousMetadata, error.message, "error");
      notify(error.message);
    } finally {
      elements.datasheetInput.value = "";
    }
  });

  elements.removeDatasheet.addEventListener("click", () => {
    draftDatasheetBlob = null;
    draftDatasheetMetadata = null;
    showDraftDatasheet(null, "O PDF será removido ao salvar.");
  });

  elements.chooseImage.addEventListener("click", () => elements.imageInput.click());
  elements.chooseDatasheet.addEventListener("click", () => elements.datasheetInput.click());
  elements.importButton.addEventListener("click", () => elements.importInput.click());
  elements.importInput.addEventListener("change", () => importJson(elements.importInput.files[0]));
  elements.exportButton.addEventListener("click", exportJson);
  elements.xlsxButton?.addEventListener("click", exportXlsx);
  elements.csvButton.addEventListener("click", exportCsv);

  elements.modal.addEventListener("click", (event) => {
    if (event.target === elements.modal) closeInventoryModal();
  });
  elements.modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeInventoryModal();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(elements.dialog.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])"))
      .filter((element) => !element.disabled && !element.hidden);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY || event.newValue === event.oldValue) return;
    if (!elements.modal.hidden) {
      pendingExternalInventoryUpdate = true;
      elements.save.disabled = true;
      notify("O estoque foi alterado em outra aba. Feche este formulário para recarregar sem sobrescrever dados.");
      return;
    }
    items = [];
    readInventory();
    renderInventory();
    notify("Estoque atualizado a partir de outra aba.");
  });

  window.addEventListener("beforeunload", () => {
    releaseCardImages();
    releaseDraftPreview();
  });

  readInventory();
  const seededItems = applyBundledInventorySeed();
  if (seededItems > 0) {
    notify(`${seededItems} componentes do Inventario box foram adicionados ao estoque local.`);
  }
  openImageDatabase().then(() => {
    imageDatabaseAvailable = true;
    updateStorageState();
    renderInventory();
  }).catch(() => {
    imageDatabaseAvailable = false;
    elements.imageInput.disabled = true;
    elements.chooseImage.disabled = true;
    elements.datasheetInput.disabled = true;
    elements.chooseDatasheet.disabled = true;
    updateStorageState();
  });
  renderInventory();
})();
