(() => {
  "use strict";

  const config = window.AM07_INVENTORY_CLOUD;
  if (config?.provider !== "firebase") return;

  const ROOT = "am07Inventory";
  const CHUNK_LENGTH = 524288;
  const MAX_PDF_DATA_LENGTH = 13981100;
  let cachedDocument = null;

  function conflict(message = "O estoque mudou em outro dispositivo") {
    return Object.assign(new Error(message), { code: "40001", status: 409 });
  }

  async function request(path, options = {}) {
    if (!config.databaseURL) throw new Error("Configure a URL do Realtime Database do Firebase.");
    const url = new URL(config.databaseURL);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${ROOT}/${path}.json`;
    const response = await fetch(url, {
      cache: "no-store",
      ...options,
      signal: AbortSignal.timeout(30000)
    });
    if (response.ok) return { value: await response.json(), etag: response.headers.get("ETag") };
    const details = await response.json().catch(() => ({}));
    throw Object.assign(new Error(details.error || `Erro HTTP ${response.status}`), {
      code: response.status === 412 ? "40001" : "firebase/request-failed",
      status: response.status
    });
  }

  function normalizeDocument(value) {
    if (value === null) return { schemaVersion: 3, revision: 0, items: [], datasheets: {} };
    if (value?.schemaVersion !== 3 || !Number.isSafeInteger(value.revision) || value.revision < 0) {
      throw new Error("Formato do estoque Firebase incompatível.");
    }
    if (value.items != null && typeof value.items !== "object") {
      throw new Error("Lista de componentes Firebase inválida.");
    }
    return { ...value, items: Object.values(value.items ?? {}).filter(Boolean), datasheets: value.datasheets ?? {} };
  }

  async function snapshot() {
    const result = await request("stock", { headers: { "X-Firebase-ETag": "true" } });
    if (!result.etag) throw new Error("O Firebase não retornou a versão necessária para salvar o estoque.");
    return { document: normalizeDocument(result.value), etag: result.etag };
  }

  async function read() {
    // Poll only the small revision field while the inventory is unchanged.
    if (cachedDocument) {
      const result = await request("stock/revision");
      if (result.value === cachedDocument.revision) return cachedDocument;
    }
    cachedDocument = (await snapshot()).document;
    return cachedDocument;
  }

  async function commit(document, etag) {
    const result = await request("stock", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "if-match": etag },
      body: JSON.stringify(document)
    });
    cachedDocument = normalizeDocument(result.value);
    return cachedDocument;
  }

  function itemKey(id) {
    const encoded = new TextEncoder().encode(id);
    return btoa(String.fromCharCode(...encoded)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function removeFiles(fileIds) {
    // A failed cleanup never rolls back an already confirmed stock update.
    await Promise.all(fileIds.map(async (id) => {
      try {
        await request(`files/${id}`, { method: "DELETE" });
      } catch (error) {
        console.warn("Não foi possível limpar um datasheet substituído:", error);
      }
    }));
  }

  async function write(parameters) {
    const current = await snapshot();
    if (current.document.revision !== parameters.p_revision) throw conflict();
    const items = parameters.p_items;
    const attachments = parameters.p_attachments ?? [];
    if (!Array.isArray(items) || items.length > 2000 || !Array.isArray(attachments)) {
      throw new Error("Lista de componentes inválida.");
    }
    const datasheets = { ...current.document.datasheets };
    const retainedKeys = new Set(items.filter((item) => item.hasDatasheet).map((item) => itemKey(item.id)));
    const uploadedFiles = [];
    try {
      for (const attachment of attachments) {
        if (attachment.kind !== "datasheet") throw new Error("Somente datasheets em PDF são aceitos.");
        const key = itemKey(attachment.id);
        if (!attachment.payload || !retainedKeys.has(key)) {
          delete datasheets[key];
          continue;
        }
        const payload = attachment.payload;
        if (typeof payload.data !== "string" || !payload.data.startsWith("data:application/pdf;base64,") || payload.data.length > MAX_PDF_DATA_LENGTH) {
          throw new Error("Datasheet inválido ou maior que 10 MB.");
        }
        // Firebase limits a single string to 10 MB. Split PDFs to preserve the existing 10 MB file limit.
        const chunks = [];
        for (let offset = 0; offset < payload.data.length; offset += CHUNK_LENGTH) {
          chunks.push(payload.data.slice(offset, offset + CHUNK_LENGTH));
        }
        const fileId = crypto.randomUUID();
        uploadedFiles.push(fileId);
        await request(`files/${fileId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chunks, fileName: payload.fileName || "datasheet.pdf", itemKey: key })
        });
        datasheets[key] = fileId;
      }
      for (const key of Object.keys(datasheets)) {
        if (!retainedKeys.has(key)) delete datasheets[key];
      }
    } catch (error) {
      await removeFiles(uploadedFiles);
      throw error;
    }
    let result;
    try {
      result = await commit({ schemaVersion: 3, revision: current.document.revision + 1, items, datasheets }, current.etag);
    } catch (error) {
      // A timeout may mean the commit succeeded. Keep uploaded files unless the server rejected it definitively.
      if (error.status === 412 || error.status === 400 || error.status === 401 || error.status === 403) {
        await removeFiles(uploadedFiles);
      }
      throw error;
    }
    const remainingFiles = new Set(Object.values(datasheets));
    void removeFiles(Object.values(current.document.datasheets).filter((id) => !remainingFiles.has(id)));
    return result;
  }

  async function adjust(parameters) {
    if (parameters.p_delta !== 1 && parameters.p_delta !== -1) throw new Error("Ajuste inválido.");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await snapshot();
      const item = current.document.items.find((candidate) => candidate.id === parameters.p_id);
      if (!item) throw conflict("Componente excluído em outro dispositivo");
      if (parameters.p_delta < 0 && (item.quantityKnown === false || item.quantity <= 0)) {
        cachedDocument = current.document;
        return cachedDocument;
      }
      const quantity = item.quantityKnown === false ? 1 : Math.max(0, Math.min(1000000000, Number(item.quantity || 0) + parameters.p_delta));
      const items = current.document.items.map((candidate) => candidate.id === item.id
        ? { ...candidate, quantity, quantityKnown: true, updatedAt: new Date().toISOString() }
        : candidate);
      try {
        return await commit({ ...current.document, revision: current.document.revision + 1, items }, current.etag);
      } catch (error) {
        if (error.status !== 412) throw error;
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 50 * (2 ** attempt)));
      }
    }
    throw conflict();
  }

  async function attachment(parameters) {
    if (parameters.p_kind !== "datasheet") return null;
    const document = await read();
    const fileId = document.datasheets[itemKey(parameters.p_id)];
    if (!fileId) return null;
    const result = await request(`files/${fileId}`);
    if (!result.value) throw new Error("O datasheet cadastrado está indisponível.");
    return { data: Object.values(result.value.chunks ?? {}).join(""), fileName: result.value.fileName };
  }

  window.AM07_FIREBASE_INVENTORY = async (operation, parameters = {}) => {
    if (operation === "read") return read();
    if (operation === "write") return write(parameters);
    if (operation === "adjust") return adjust(parameters);
    if (operation === "attachment") return attachment(parameters);
    throw new Error("Operação de inventário desconhecida.");
  };
})();
