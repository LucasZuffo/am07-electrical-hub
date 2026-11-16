begin;

set local lock_timeout = '5s';

create schema if not exists inventory_private;
revoke all on schema inventory_private from public, anon, authenticated;

create table if not exists inventory_private.stock (
  singleton boolean primary key default true check (singleton),
  revision bigint not null default 0,
  items jsonb not null default '[]'::jsonb
);
insert into inventory_private.stock (singleton) values (true) on conflict do nothing;

create table if not exists inventory_private.attachments (
  item_id text not null,
  kind text not null check (kind = 'datasheet'),
  payload jsonb not null,
  primary key (item_id, kind)
);

-- Remove legacy catalog images when this script is applied to an existing inventory.
lock table inventory_private.stock in exclusive mode;

update inventory_private.stock
set items = (
  select jsonb_agg(value - 'hasImage' order by ordinality)
  from jsonb_array_elements(items) with ordinality
), revision = revision + 1
where exists (select 1 from jsonb_array_elements(items) as i where i ? 'hasImage');

delete from inventory_private.attachments where kind = 'image';
alter table inventory_private.attachments drop constraint if exists attachments_kind_check;
alter table inventory_private.attachments add constraint attachments_kind_check check (kind = 'datasheet');

create or replace function public.am07_inventory_read()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return (select jsonb_build_object('revision', revision, 'items', items, 'schemaVersion', 3)
          from inventory_private.stock);
end;
$$;

create or replace function public.am07_inventory_attachment(p_id text, p_kind text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return (select payload from inventory_private.attachments
          where item_id = p_id and kind = 'datasheet' and kind = p_kind);
end;
$$;

create or replace function public.am07_inventory_write(p_revision bigint, p_items jsonb, p_attachments jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  attachment jsonb;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_typeof(p_attachments) is distinct from 'array' then
    raise exception 'Formato de estoque inválido';
  end if;
  if jsonb_array_length(p_items) > 2000 or jsonb_array_length(p_attachments) > 4000
     or exists (select 1 from jsonb_array_elements(p_items) as i
                where coalesce(length(i->>'id'), 0) not between 1 and 80
                   or coalesce(length(i->>'name'), 0) not between 1 and 80
                   or coalesce(length(i->>'category'), 0) not between 1 and 50)
     or (select count(distinct i->>'id') from jsonb_array_elements(p_items) as i) <> jsonb_array_length(p_items) then
    raise exception 'Lista de componentes inválida';
  end if;

  update inventory_private.stock set items = p_items, revision = revision + 1
    where revision = p_revision;
  if not found then
    raise exception 'O estoque mudou em outro dispositivo' using errcode = '40001';
  end if;

  for attachment in select value from jsonb_array_elements(p_attachments) loop
    if attachment->>'kind' is distinct from 'datasheet' then
      raise exception 'Somente datasheets em PDF são aceitos';
    end if;
    if attachment->'payload' is null or attachment->'payload' = 'null'::jsonb then
      delete from inventory_private.attachments
        where item_id = attachment->>'id' and kind = attachment->>'kind';
    else
      if not coalesce(attachment->'payload'->>'data' ~ '^data:application/pdf;base64,'
                     and length(attachment->'payload'->>'data') <= 13981100, false) then
        raise exception 'Anexo inválido';
      end if;
      insert into inventory_private.attachments (item_id, kind, payload)
      values (attachment->>'id', attachment->>'kind', attachment->'payload')
      on conflict (item_id, kind) do update set payload = excluded.payload;
    end if;
  end loop;

  delete from inventory_private.attachments a
    where not exists (
      select 1 from jsonb_array_elements(p_items) as i
      where i->>'id' = a.item_id
        and i->>'hasDatasheet' = 'true'
    );
  return public.am07_inventory_read();
end;
$$;

create or replace function public.am07_inventory_adjust(p_id text, p_delta integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_items jsonb;
  current_item jsonb;
  item_index integer;
  quantity numeric;
begin
  if p_delta is null or p_delta not in (-1, 1) then raise exception 'Ajuste inválido'; end if;
  select items into current_items from inventory_private.stock where singleton = true for update;
  select value, (ordinality - 1)::integer into current_item, item_index
    from jsonb_array_elements(current_items) with ordinality where value->>'id' = p_id;
  if not found then raise exception 'Componente excluído em outro dispositivo' using errcode = '40001'; end if;
  if current_item->>'quantityKnown' = 'false' and p_delta = -1 then
    return public.am07_inventory_read();
  end if;

  quantity := case when current_item->>'quantityKnown' = 'false' then 1
    else greatest(0, least(1000000000, coalesce((current_item->>'quantity')::numeric, 0) + p_delta)) end;
  current_item := current_item || jsonb_build_object(
    'quantity', quantity, 'quantityKnown', true, 'updatedAt', clock_timestamp()
  );
  update inventory_private.stock
    set items = jsonb_set(current_items, array[item_index::text], current_item), revision = revision + 1
    where singleton = true;
  return public.am07_inventory_read();
end;
$$;

revoke all on function public.am07_inventory_read(), public.am07_inventory_attachment(text, text),
  public.am07_inventory_write(bigint, jsonb, jsonb), public.am07_inventory_adjust(text, integer)
  from public, anon, authenticated;
grant execute on function public.am07_inventory_read(), public.am07_inventory_attachment(text, text),
  public.am07_inventory_write(bigint, jsonb, jsonb), public.am07_inventory_adjust(text, integer)
  to anon, authenticated;

commit;
