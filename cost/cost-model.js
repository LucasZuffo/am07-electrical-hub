(function (root) {
  'use strict';
  const norm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f\u200B-\u200D\uFEFF]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
  const key = value => norm(value).replace(/\s+/g, '');
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const safeUrl = value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
  };
  function compare(source, plan, inventory) {
    const entries = plan.entries || {};
    const byCode = new Map(source.rows.map(row => [row.code, row]));
    const byId = new Map(inventory.map(item => [item.id, item]));
    const quantities = new Map();
    function quantity(row, seen = new Set()) {
      if (quantities.has(row.code)) return quantities.get(row.code);
      if (seen.has(row.code)) throw new Error('Ciclo na estrutura do Cost.');
      const own = entries[row.code]?.quantity ?? row.quantity;
      let result = numeric(own) ? own : null;
      if (row.parentCode) {
        const parent = byCode.get(row.parentCode);
        const parentQty = parent ? quantity(parent, new Set([...seen, row.code])) : null;
        result = result === 0 || parentQty === 0 ? 0 : result == null || parentQty == null ? null : result * parentQty;
      }
      if (result != null && !Number.isFinite(result)) result = null;
      quantities.set(row.code, result);
      return result;
    }
    const rows = source.rows.map(row => {
      const entry = entries[row.code] || {};
      const explicit = Object.hasOwn(entry, 'inventoryId');
      const candidates = inventory.filter(item => item.sku && key(item.sku) === key(row.code));
      const item = explicit ? byId.get(entry.inventoryId) : candidates.length === 1 ? candidates[0] : undefined;
      const applicable = row.type !== 'A' && !row.contextOnly;
      const compatible = item && key(row.unit) === key(item.unit);
      const factor = numeric(entry.conversion) && entry.conversion > 0 ? entry.conversion : compatible ? 1 : null;
      const carQuantity = quantity(row);
      const inventoryNeed = carQuantity === 0 ? 0 : carQuantity == null || factor == null ? null : carQuantity * factor;
      const unitCost = numeric(entry.unitCost) ? entry.unitCost : item?.unitCostKnown === true && numeric(item.unitCost) && factor != null ? item.unitCost * factor : null;
      const cost = !applicable ? null : carQuantity === 0 ? 0 : unitCost == null || carQuantity == null ? null : unitCost * carQuantity;
      let depth = 0, parent = row;
      while (parent.parentCode && byCode.has(parent.parentCode)) { depth++; parent = byCode.get(parent.parentCode); if(depth>source.rows.length)throw new Error('Ciclo na estrutura.'); }
      return {...row, entry, item, applicable, depth, ambiguous: !explicit && candidates.length > 1, deletedLink: explicit && Boolean(entry.inventoryId) && !item, ownQuantity:entry.quantity ?? row.quantity, carQuantity, factor, inventoryNeed, unitCost, cost, hasDatasheet:Boolean(item && (item.hasDatasheet || safeUrl(item.datasheetUrl))), unitCostSource:numeric(entry.unitCost)?'Cost':unitCost!=null?'Inventário':'', group:null};
    });
    const groups = new Map();
    for (const row of rows.filter(row=>row.applicable && row.item)) {
      if (!groups.has(row.item.id)) groups.set(row.item.id, {item:row.item,rows:[],need:0,known:true,shortage:null});
      const group=groups.get(row.item.id); group.rows.push(row); row.group=group;
      if (row.inventoryNeed == null) group.known=false; else group.need+=row.inventoryNeed;
    }
    for(const group of groups.values()) {
      group.stockKnown=group.item.quantityKnown!==false && numeric(group.item.quantity);
      if(group.known && group.stockKnown) group.shortage=Math.max(0,group.need-group.item.quantity);
    }
    for(const row of rows) {
      row.issues=[];
      if(!row.applicable)continue;
      if(!row.item)row.issues.push(row.ambiguous?'ambiguous':'unlinked');
      if(!row.hasDatasheet)row.issues.push('datasheet');
      if(row.carQuantity==null)row.issues.push('quantity');
      if(row.item && row.factor==null)row.issues.push('unit');
      if(row.group && !row.group.stockKnown)row.issues.push('count');
      if(row.group?.shortage>0)row.issues.push('shortage');
      if(row.unitCost==null && row.carQuantity!==0)row.issues.push('price');
    }
    function summary(department) {
      const visible=rows.filter(r=>!r.contextOnly && (!department || r.department===department));
      const parts=visible.filter(r=>r.applicable);
      const stockGroups=[...new Set(parts.map(r=>r.group).filter(Boolean))];
      const knownCosts=parts.filter(r=>r.cost!=null);
      return {lines:visible.length,assemblies:visible.filter(r=>r.type==='A').length,parts:parts.length,unlinked:parts.filter(r=>!r.item).length,datasheets:parts.filter(r=>!r.hasDatasheet).length,quantities:parts.filter(r=>r.carQuantity==null).length,shortageGroups:stockGroups.filter(g=>g.shortage>0).length,uncheckedGroups:stockGroups.filter(g=>!g.known || !g.stockKnown).length,knownCost:knownCosts.reduce((s,r)=>s+r.cost,0),pricedLines:knownCosts.length,missingCost:parts.length-knownCosts.length};
    }
    return {rows,byCode:new Map(rows.map(r=>[r.code,r])),groups,summary};
  }
  root.AM07_COST_MODEL={compare,norm,safeUrl};
  if(typeof module!=='undefined' && module.exports)module.exports=root.AM07_COST_MODEL;
})(typeof window==='undefined'?globalThis:window);
