(() => {
  'use strict';
  const source=window.AM07_COST_SOURCE, model=window.AM07_COST_MODEL;
  const $=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const number=value=>value==null?'A definir':new Intl.NumberFormat('pt-BR',{maximumFractionDigits:4}).format(value);
  const money=value=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value);
  const labels={unlinked:'Sem vínculo',ambiguous:'Código duplicado',datasheet:'Sem datasheet',quantity:'Qtd. a definir',unit:'Conferir unidade',count:'Sem contagem',shortage:'Quantidade em falta',price:'Sem preço'};
  let department='HV', inventory=[], plan={schemaVersion:1,revision:0,sourceId:source.sourceId,entries:{}}, comparison=null, ready=false, refreshing=false, editing=null, editRevision=null, stale=false, saving=false, toastTimer;
  const collapsed=new Set();
  function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5500);}
  async function request(path,options={}){
    const base=new URL(window.AM07_INVENTORY_CLOUD.databaseURL);
    base.pathname=`${base.pathname.replace(/\/+$/,'')}/am07Cost/${path}.json`;
    const response=await fetch(base,{cache:'no-store',...options,signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Object.assign(new Error(response.status===412?'O planejamento mudou em outro dispositivo. Feche e reabra esta edição para conferir os novos valores.':`Não foi possível acessar o planejamento (HTTP ${response.status}).`),{status:response.status});
    return {value:await response.json(),etag:response.headers.get('ETag')};
  }
  function validatePlan(value){
    if(value==null)return {schemaVersion:1,revision:0,sourceId:source.sourceId,entries:{}};
    if(value.schemaVersion!==1 || value.sourceId!==source.sourceId || !Number.isSafeInteger(value.revision) || value.revision<1)throw new Error('A versão do planejamento não corresponde à planilha publicada.');
    return {...value,entries:value.entries||{}};
  }
  async function readPlan(){
    if(plan.revision){const check=await request('plan/revision');if(check.value===plan.revision)return plan;}
    return validatePlan((await request('plan')).value);
  }
  async function refresh(){
    if(refreshing)return;refreshing=true;$('refresh').disabled=true;
    try{
      const [stock,nextPlan]=await Promise.all([window.AM07_FIREBASE_INVENTORY('read'),readPlan()]);
      inventory=stock.items;plan=nextPlan;ready=true;stale=false;
      comparison=model.compare(source,plan,inventory);
      $('connection').classList.remove('error');$('connection').textContent=`Estoque compartilhado atualizado às ${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})} · ${inventory.length} itens no inventário`;
      render();
    }catch(error){stale=true;$('connection').classList.add('error');$('connection').textContent=ready?`${error.message} A comparação abaixo mantém a última leitura.`:`${error.message} A comparação ficará disponível quando a conexão voltar.`;render();}
    finally{refreshing=false;$('refresh').disabled=false;}
  }
  function ancestors(code){const result=[];let row=comparison.byCode.get(code);while(row?.parentCode){row=comparison.byCode.get(row.parentCode);if(!row)break;result.push(row);}return result;}
  function ownRows(){
    if(!comparison)return [];
    const query=model.norm($('search').value),issue=$('issue').value,type=$('type').value;
    return comparison.rows.filter(row=>!row.contextOnly && row.department===department).filter(row=>{
      const haystack=model.norm([row.code,row.name,row.parentCode,row.system,...ancestors(row.code).flatMap(x=>[x.code,x.name])].join(' '));
      const issueMatches=issue==='all' || issue==='unlinked' && row.applicable && !row.item || row.issues.includes(issue) || issue==='quantity' && row.type==='A' && row.carQuantity==null;
      return (!query || query.split(' ').every(term=>haystack.includes(term))) && (type==='all'||row.type===type) && issueMatches;
    });
  }
  function stat(title,value,detail){return `<article><h3>${esc(title)}</h3><strong>${esc(value)}</strong><p>${esc(detail)}</p></article>`;}
  function render(){
    $('saveEditor').disabled=!ready || stale || saving;
    if(!comparison){$('summary').innerHTML=stat('SEM VÍNCULO','—','Aguardando o inventário')+stat('SEM DATASHEET','—','Aguardando o inventário')+stat('FALTA DE QUANTIDADE','—','Aguardando o inventário')+stat('CUSTO CONHECIDO','—','Aguardando o planejamento');$('rows').replaceChildren();return;}
    const stats=comparison.summary(department);
    $('summary').innerHTML=stat('SEM VÍNCULO',stats.unlinked,'Peças a conferir no inventário')+stat('SEM DATASHEET',stats.datasheets,'Peças sem PDF ou link vinculado')+stat('FALTA DE QUANTIDADE',stats.shortageGroups || (stats.unlinked || stats.uncheckedGroups ? 'A conferir' : 0),`${stats.quantities} linhas com quantidade a definir · ${stats.uncheckedGroups} grupos com estoque ou unidade pendente`)+stat(stats.missingCost?'SUBTOTAL CONHECIDO':'CUSTO PARA 1 CARRO',stats.pricedLines?money(stats.knownCost):'A preencher',`${stats.pricedLines} de ${stats.parts} linhas calculadas · ${stats.missingCost} pendentes`);
    const selected=ownRows(), included=new Set(selected.map(r=>r.code));
    for(const row of selected)for(const parent of ancestors(row.code))included.add(parent.code);
    const activeFilter=Boolean($('search').value.trim())||$('issue').value!=='all'||$('type').value!=='all';
    const children=new Map();for(const row of comparison.rows){const p=row.parentCode||'';if(!children.has(p))children.set(p,[]);children.get(p).push(row);}
    const visible=[];
    function visit(parent){for(const row of children.get(parent)||[]){if(!included.has(row.code))continue;visible.push(row);if(activeFilter||!collapsed.has(row.code))visit(row.code);}}
    visit('');
    $('viewCount').textContent=`${department} · ${stats.lines} linhas na planilha · ${stats.assemblies} assemblies · ${selected.length} linhas nos filtros${stale?' · leitura desatualizada':''}`;
    $('rows').innerHTML=visible.map(row=>{
      const context=row.contextOnly || row.department!==department;
      const hasChildren=(children.get(row.code)||[]).some(child=>included.has(child.code));
      const toggle=hasChildren?`<button type="button" class="tree-toggle" data-collapse="${esc(row.code)}" aria-label="${collapsed.has(row.code)?'Expandir':'Recolher'} ${esc(row.name)}" aria-expanded="${activeFilter||!collapsed.has(row.code)}">${collapsed.has(row.code)&&!activeFilter?'▸':'▾'}</button>`:'';
      const item=row.item,group=row.group;
      let stock='—';
      if(!context && row.applicable){
        stock=item?`<strong>${esc(item.name)}</strong><small>${esc(item.sku||'Sem código no inventário')}</small><span>${group.stockKnown?number(item.quantity):'Sem contagem'} ${esc(item.unit)}</span><small>Demanda HV + EL: ${group.known?number(group.need):'A definir'} ${esc(item.unit)}${group.rows.length>1?` · ${group.rows.length} linhas`:''}</small>${group.shortage>0?`<small class="error">Faltam ${number(group.shortage)} ${esc(item.unit)} no grupo</small>`:''}`:'A vincular';
        if(item?.datasheetUrl && model.safeUrl(item.datasheetUrl))stock+=`<a href="${esc(model.safeUrl(item.datasheetUrl))}" target="_blank" rel="noopener">Abrir datasheet</a>`;
      }
      let statuses=context?'<span class="status">Contexto do conjunto</span>':row.type==='A'?(row.carQuantity==null?'<span class="status">Definir qtd. do conjunto</span>':'<span class="type">Assembly</span>'):row.issues.map(issue=>`<span class="status ${['shortage','unlinked','ambiguous'].includes(issue)?'red':''}">${labels[issue]}</span>`).join('')||'<span class="status green">Cadastro, PDF e saldo conferidos</span>';
      let total=row.cost,coverage='';
      if(row.type==='A'||context){const parts=comparison.rows.filter(r=>r.applicable && r.department===department && ancestors(r.code).some(a=>a.code===row.code));const known=parts.filter(r=>r.cost!=null);total=known.length?known.reduce((s,r)=>s+r.cost,0):null;coverage=`${known.length} de ${parts.length} linhas calculadas nesta gerência`;}
      return `<tr class="${row.type==='A'?'assembly ':''}${context?'context':''}"><td class="part-cell"><div class="part-content" style="--depth:${row.depth}"><span class="code">${toggle}${esc(row.code)}</span><strong>${esc(row.name)}</strong><span class="parent">${row.parentCode?`Pai: ${esc(row.parentCode)}`:esc(row.system)}${context?` · ${esc(row.department)}`:''}</span></div></td><td><span class="type ${esc(row.type)}">${esc(row.type)} · ${esc(source.typeLabels[row.type]||row.type)}</span></td><td class="number">${number(row.ownQuantity)}<small>${esc(row.unit)}</small></td><td class="number">${number(row.carQuantity)}<small>${esc(row.unit)}</small></td><td class="stock-detail">${stock}</td><td><div class="status-list">${statuses}</div></td><td class="number">${row.applicable&&!context&&row.unitCost!=null?money(row.unitCost):'—'}<small>${!context?esc(row.unitCostSource):''}</small></td><td class="number">${total==null?'A preencher':money(total)}${row.type==='A'||context?`<small>${esc(coverage)}</small>`:''}</td><td><button type="button" class="row-action" data-edit="${esc(row.code)}" ${stale?'disabled':''}>${row.type==='A'||context?'Editar quantidade':'Editar / vincular'}</button></td></tr>`;
    }).join('');$('empty').hidden=selected.length>0;
  }
  function openEditor(code){
    if(!ready||stale)return;const row=comparison.byCode.get(code);editing=code;editRevision=plan.revision;
    $('editorCode').textContent=`${row.code} · ${source.typeLabels[row.type]}`;$('editorTitle').textContent=row.name;
    $('editorContext').textContent=`Gerência ${row.department}${row.parentCode?` · Pai ${row.parentCode} · Quantidade por unidade do pai.`:' · Conjunto raiz · Quantidade de conjuntos para montar 1 carro.'}`;
    $('quantityLabel').textContent=row.parentCode?'Quantidade por unidade do pai':'Quantidade deste conjunto para 1 carro';
    $('editQuantity').value=row.entry.quantity??'';$('sourceQuantity').textContent=`Na planilha: ${number(row.quantity)} ${row.unit}. Em branco: manter esse valor.`;
    $('editPrice').value=row.entry.unitCost??'';$('editConversion').value=row.entry.conversion??'';
    const suggested=inventory.filter(item=>model.norm(item.name)===model.norm(row.name));
    const sorted=[...inventory].sort((a,b)=>model.norm(a.name).localeCompare(model.norm(b.name),'pt-BR'));
    $('editInventory').innerHTML=`<option value="__auto__">Usar correspondência por código único</option><option value="">Sem vínculo — conferir ou cadastrar no inventário</option>`+sorted.map(item=>`<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.sku||'sem código')} · ${item.quantityKnown===false?'sem contagem':number(item.quantity)+' '+esc(item.unit)}${suggested.includes(item)?' · mesmo nome':''}</option>`).join('');
    if(row.deletedLink)$('editInventory').insertAdjacentHTML('beforeend',`<option value="${esc(row.entry.inventoryId)}">Item vinculado não encontrado — escolha outro</option>`);
    $('editInventory').value=Object.hasOwn(row.entry,'inventoryId')?row.entry.inventoryId:'__auto__';
    for(const id of ['priceField','inventoryField','conversionField'])$(id).hidden=!row.applicable;
    $('originalData').innerHTML=source.originalColumns.map(column=>`<dt>${esc(column)}</dt><dd>${esc(row.original[column]??'Não informado')}</dd>`).join('');
    $('editorError').textContent='';$('editor').showModal();
  }
  async function saveEditor(event){
    event.preventDefault();if(!editing||!ready||stale||saving)return;
    const editingCode=editing,expectedRevision=editRevision,row=comparison.byCode.get(editingCode),entry={...row.entry};
    for(const [id,field] of [['editQuantity','quantity'],['editPrice','unitCost'],['editConversion','conversion']]){
      if(!row.applicable && field!=='quantity'){delete entry[field];continue;}
      const input=$(id);if(input.value==='')delete entry[field];else{const value=Number(input.value);if(!Number.isFinite(value)||value<0||value>1e9||field==='conversion'&&value<=0){$('editorError').textContent='Confira os números informados.';return;}entry[field]=value;}
    }
    if(row.applicable){if($('editInventory').value==='__auto__')delete entry.inventoryId;else entry.inventoryId=$('editInventory').value;}
    saving=true;$('saveEditor').disabled=true;$('editorError').textContent='';
    try{
      const current=await request('plan',{headers:{'X-Firebase-ETag':'true'}}),document=validatePlan(current.value);
      if(!current.etag)throw new Error('O banco não retornou a versão necessária para salvar.');
      if(document.revision!==expectedRevision)throw new Error('O planejamento mudou em outro dispositivo. Feche e reabra esta edição para conferir os novos valores.');
      const entries={...document.entries};if(Object.keys(entry).length)entries[editingCode]=entry;else delete entries[editingCode];
      const next={schemaVersion:1,sourceId:source.sourceId,revision:document.revision+1,entries};
      const saved=await request('plan',{method:'PUT',headers:{'Content-Type':'application/json','if-match':current.etag},body:JSON.stringify(next)});
      plan=validatePlan(saved.value);comparison=model.compare(source,plan,inventory);$('editor').close();editing=null;render();toast('Planejamento salvo para a equipe.');
    }catch(error){$('editorError').textContent=error.name==='TimeoutError'?'A gravação demorou. Atualize e confira os valores antes de salvar novamente.':error.message;}
    finally{saving=false;$('saveEditor').disabled=!ready||stale;}
  }
  function exportCsv(){
    if(!comparison)return;
    const records=ownRows(), extra=['Qtd por pai usada','Qtd para 1 carro','Item inventário','Código inventário','Saldo inventário','Unidade inventário','Demanda agrupada HV+EL','Falta agrupada HV+EL','Datasheet no inventário','Custo unitário usado (R$)','Total calculado (R$)','Pendências'];
    const cell=value=>{let text=typeof value==='number'?String(value).replace('.',','):String(value??'');if(/^[=+\-@]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
    const rows=[source.originalColumns.concat(extra),...records.map(r=>source.originalColumns.map(c=>r.original[c]??'').concat([r.ownQuantity,r.carQuantity,r.item?.name,r.item?.sku,r.group?.stockKnown?r.item.quantity:'',r.item?.unit,r.group?.known?r.group.need:'',r.group?.shortage,r.applicable?r.hasDatasheet?'Sim':'Não':'',r.unitCost,r.cost,r.issues.map(i=>labels[i]).join(' / ')]))];
    const blob=new Blob(['\uFEFF'+rows.map(r=>r.map(cell).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`am07-cost-${department.toLowerCase()}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function selectDepartment(value){department=value;for(const tab of document.querySelectorAll('[data-department]')){const active=tab.dataset.department===value;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;}$('departmentPanel').setAttribute('aria-labelledby','tab'+value);render();}
  document.querySelectorAll('[data-department]').forEach(tab=>{tab.addEventListener('click',()=>selectDepartment(tab.dataset.department));tab.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const value=event.key==='Home'?'HV':event.key==='End'?'EL':department==='HV'?'EL':'HV';selectDepartment(value);$('tab'+value).focus();}});});
  for(const id of ['search','issue','type'])$(id).addEventListener(id==='search'?'input':'change',render);
  $('rows').addEventListener('click',event=>{const edit=event.target.closest('[data-edit]'),collapse=event.target.closest('[data-collapse]');if(edit)openEditor(edit.dataset.edit);if(collapse){const code=collapse.dataset.collapse;collapsed.has(code)?collapsed.delete(code):collapsed.add(code);render();}});
  for(const id of ['closeEditor','cancelEditor'])$(id).addEventListener('click',()=>{if(!saving)$('editor').close();});
  $('editor').addEventListener('cancel',event=>{if(saving)event.preventDefault();});
  $('editForm').addEventListener('submit',saveEditor);$('refresh').addEventListener('click',refresh);$('export').addEventListener('click',exportCsv);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});window.addEventListener('focus',refresh);setInterval(()=>{if(!document.hidden)refresh();},15000);
  render();refresh();
})();
