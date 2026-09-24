import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseOaReadConfig } from "../src/config/oaReadConfig.js";
import { parseMetadata, materializeMetadata, diffSchema, impactedEntities, validateReferences, type SchemaSnapshot, type PublishedMetadata } from "../src/infrastructure/oa-read/metadata.js";
import { ADMIN_TABLES, DENIED_TABLES, tableAccess } from "../src/infrastructure/oa-read/accessPolicy.js";
import { compileQuery } from "../src/infrastructure/oa-read/queryCompiler.js";
import { synchronizeMetadata, readCatalogState } from "../src/infrastructure/oa-read/schemaSync.js";
import { OaReadService, readToolToken } from "../src/infrastructure/oa-read/readService.js";
import { withDatabaseReadRouting, databaseReadGuidance } from "../src/infrastructure/oa-read/routing.js";
import { buildOpenApiIndex } from "../src/infrastructure/oa/openApiIndex.js";
import { isOaReadOperation } from "../src/infrastructure/oa/oaApiTool.js";
import type { ReadDatabase, ReadQuery } from "../src/infrastructure/oa-read/database.js";

const semantic = parseMetadata({ format: 1, description: "test", rules: [], entities: [
  { name: "members", table: "user", description: "members", access: "self", ownerColumn: "id", columns: { id: { description: "ID" }, name: { description: "name" } }, references: [] },
  { name: "projects", table: "projects", description: "projects", access: "authenticated", columns: { id: { description: "ID" }, owner: { description: "owner" }, deleted: { description: "deleted" } }, filters: [{ column: "deleted", value: 0 }], references: [{ column: "owner", entity: "members", targetColumn: "id" }] },
  { name: "salaries", table: "user_weekly_salary", description: "salary", access: "admin", columns: { id: { description: "ID" } } },
] });
const schema: SchemaSnapshot = { database: "oa", tables: semantic.entities.map(e => ({ name: e.table, kind: "BASE TABLE", comment: "", columns: Object.keys(e.columns).map((name, i) => ({ name, type: name === "name" ? "varchar(255)" : "int", nullable: "YES", defaultValue: null, comment: "", extra: "", ordinal: i + 1, collation: null, generation: "" })), indexes: [], foreignKeys: [], viewDefinition: null, dependencies: [] })) };
const published: PublishedMetadata = { version: "v1", publishedAt: "2026-09-23", schema, semantic };
const principal = { userId: "7", isAdmin: false };
const basic = { from: { entity: "members", as: "m" }, select: [{ field: "m.id", as: "id" }] };

test("readonly config is opt-in, bounded and never leaks a malformed URL", () => {
  assert.equal(parseOaReadConfig({}, "/tmp"), null);
  assert.equal(parseOaReadConfig({ DATABASE_URL_READ: "mysql://u:p@host/oa" }, "/tmp")?.syncIntervalSeconds, 300);
  assert.throws(() => parseOaReadConfig({ DATABASE_URL_READ: "mysql://u:secret@host" }, "/tmp"), e => !String(e).includes("secret"));
  assert.throws(() => parseOaReadConfig({ DATABASE_URL_READ: "mysql://u:p@host/oa", OA_READ_MAX_ROWS: "999999" }, "/tmp"));
});

test("query compiler permits cross-member reads and binds hostile values", () => {
  const malicious = "x' OR 1=1; DROP TABLE user --";
  const compiled = compileQuery({ ...basic, where: [{ field: "m.name", op: "eq", value: malicious }] }, published, principal, 100, 1000);
  assert.doesNotMatch(compiled.sql, /WHERE `id` = \?/);
  assert.ok(!compiled.sql.includes(malicious));
  assert.deepEqual(compiled.bindings, [malicious]);
  assert.match(compiled.sql, /LIMIT 101 OFFSET 0$/);
});

test("rejects SQL, raw expressions, secret columns, invisible entities and unregistered joins", () => {
  for (const bad of [
    { ...basic, sql: "SELECT * FROM mysql.user" },
    { ...basic, select: [{ field: "m.password", as: "password" }] },
    { ...basic, select: [{ field: "SLEEP(10)", as: "slow" }] },
    { ...basic, from: { entity: "salaries", as: "m" } },
    { ...basic, joins: [{ entity: "projects", as: "p", on: { left: "m.id", right: "p.id" } }] },
  ]) assert.throws(() => compileQuery(bad, published, principal, 100, 1000));
  assert.throws(() => parseMetadata({ ...semantic, entities: [{ ...semantic.entities[0], columns: { password: { description: "no" } } }] }));
});

test("joins keep fixed business filters without injecting current-user scope", () => {
  const query = { from: { entity: "projects", as: "p" }, joins: [{ entity: "members", as: "m", type: "left", on: { left: "p.owner", right: "m.id" } }], select: [{ field: "p.id", as: "id" }, { field: "m.name", as: "name" }] };
  const compiled = compileQuery(query, published, principal, 100, 1000);
  assert.deepEqual(compiled.bindings, [0]);
  assert.doesNotMatch(compiled.sql, /WHERE `id` = \?/);
  const admin = compileQuery(query, published, { userId: "7", isAdmin: true }, 100, 1000);
  assert.deepEqual(admin.bindings, [0]);
  assert.throws(() => compileQuery({ ...basic, select: [{ field: "m.password", as: "p" }] }, published, { userId: "7", isAdmin: true }, 100, 1000));
});

test("aggregate, literal contains escaping, null handling and pagination constraints", () => {
  const aggregate = compileQuery({ ...basic, select: [{ aggregate: "count", as: "total" }], where: [{ field: "m.name", op: "contains", value: "_100%!" }] }, published, principal, 2, 1000);
  assert.match(aggregate.sql, /COUNT\(\*\)/); assert.deepEqual(aggregate.bindings, ["%!_100!%!!%"]);
  assert.throws(() => compileQuery({ ...basic, offset: 10 }, published, principal, 100, 1000));
  assert.throws(() => compileQuery({ ...basic, where: [{ field: "m.id", op: "notIn", value: [null] }] }, published, principal, 100, 1000));
});

test("schema diff tracks additions removals changes and transitive view/semantic impacts", () => {
  const next = structuredClone(schema);
  next.tables[0]!.columns[1]!.type = "text";
  next.tables[1]!.indexes = [{ INDEX_NAME: "new_index" }];
  next.tables.pop();
  next.tables.push({ name: "member_view", kind: "VIEW", comment: "", columns: [], indexes: [], foreignKeys: [], viewDefinition: "select name from user", dependencies: ["user"] });
  const changes = diffSchema(schema, next);
  assert.ok(changes.some(c => c.table === "user" && c.field === "name" && c.kind === "changed"));
  assert.ok(changes.some(c => c.table === "user_weekly_salary" && c.kind === "removed"));
  assert.ok(changes.some(c => c.aspect === "indexes"));
  assert.deepEqual(new Set(impactedEntities(changes, next, semantic)), new Set(["members", "projects", "salaries"]));
  assert.ok(validateReferences(next, semantic).some(e => e.includes("salaries")));
});

function fakeDatabase(getSchema: () => SchemaSnapshot, queries: string[] = []) {
  return { read: async <T>(fn: (q: ReadQuery) => Promise<T>) => fn((async (sql: string) => {
    queries.push(sql); const snap = getSchema();
    if (sql.includes("information_schema.TABLES")) return snap.tables.map(t => ({ TABLE_NAME: t.name, TABLE_TYPE: t.kind, TABLE_COMMENT: t.comment }));
    if (sql.includes("information_schema.COLUMNS")) return snap.tables.flatMap(t => t.columns.map(c => ({ TABLE_NAME: t.name, COLUMN_NAME: c.name, COLUMN_TYPE: c.type, IS_NULLABLE: c.nullable, COLUMN_DEFAULT: c.defaultValue, COLUMN_COMMENT: c.comment, EXTRA: c.extra, ORDINAL_POSITION: c.ordinal, COLLATION_NAME: c.collation, GENERATION_EXPRESSION: c.generation })));
    if (sql.includes("information_schema.STATISTICS")) return snap.tables.flatMap(t => t.indexes);
    if (sql.includes("information_schema.KEY_COLUMN_USAGE")) return snap.tables.flatMap(t => t.foreignKeys);
    if (sql.includes("information_schema.VIEWS")) return snap.tables.filter(t => t.kind === "VIEW").map(t => ({ TABLE_NAME: t.name, VIEW_DEFINITION: t.viewDefinition }));
    if (sql.includes("information_schema.VIEW_TABLE_USAGE")) return snap.tables.flatMap(t => t.dependencies.map(d => ({ VIEW_NAME: t.name, TABLE_NAME: d, TABLE_SCHEMA: snap.database })));
    return [];
  }) as ReadQuery), close: async () => {} } as ReadDatabase;
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oa-read-test-"));
  const metadataPath = path.join(dir, "semantic.json");
  await writeFile(metadataPath, JSON.stringify(semantic));
  return { dir, config: { databaseUrl: "mysql://read:unused@localhost/oa", metadataPath, stateDirectory: dir, syncIntervalSeconds: 300, queryTimeoutMs: 1000, maxRows: 100, concurrency: 2 } };
}

test("sync atomically publishes, rejects breaking changes, preserves old version and recovers", async t => {
  const { dir, config } = await fixture(); t.after(() => rm(dir, { recursive: true, force: true }));
  let current = structuredClone(schema); const db = fakeDatabase(() => current);
  const first = await synchronizeMetadata(config, db, "manual"); assert.equal(first.status, "published");
  const same = await synchronizeMetadata(config, db, "scheduled"); assert.equal(same.status, "unchanged");
  current.tables[0]!.columns.pop();
  const broken = await synchronizeMetadata(config, db, "manual"); assert.equal(broken.status, "rejected");
  assert.equal((await readCatalogState(dir))?.active?.version, first.activeVersion);
  const service = new OaReadService(config, db);
  assert.equal((await service.call({ action: "catalog" }, principal)).ok, false);
  current = structuredClone(schema);
  assert.equal((await synchronizeMetadata(config, db, "manual")).status, "unchanged");
  assert.equal((await service.call({ action: "catalog" }, principal)).ok, true);
  await service.close();
});

test("physical-table deny/admin policy cannot be bypassed by aliases, old metadata or joins", () => {
  for (const table of [...DENIED_TABLES, ...ADMIN_TABLES, "user", "weekly_report", "copilot_record"]) {
    const entity = { ...semantic.entities[2]!, name: "public_alias", table, access: "authenticated" as const };
    const snap = structuredClone(schema);
    snap.tables.push({ ...snap.tables[2]!, name: table });
    const catalog = { ...published, schema: snap, semantic: { ...semantic, entities: [...semantic.entities, entity] } };
    catalog.semantic.entities = catalog.semantic.entities.map(e => e.name === "members" ? { ...e, references: [{ column: "id", entity: "public_alias", targetColumn: "id" }] } : e);
    for (const isAdmin of [false, true]) {
      const user = { ...principal, isAdmin };
      const blocked = DENIED_TABLES.has(table) || (ADMIN_TABLES.has(table) && !isAdmin);
      for (const query of [
        { from: { entity: "public_alias", as: "x" }, select: [{ aggregate: "count", as: "n" }] },
        { ...basic, joins: [{ entity: "public_alias", as: "x", on: { left: "m.id", right: "x.id" } }] },
      ]) {
        if (blocked) assert.throws(() => compileQuery(query, catalog, user, 100, 1000), /实体不可访问/);
        else assert.doesNotThrow(() => compileQuery(query, catalog, user, 100, 1000));
      }
    }
  }
});

test("view dependencies inherit denials and admin access transitively", () => {
  const snap = structuredClone(schema);
  const addView = (name: string, dependency: string) => snap.tables.push({ ...snap.tables[0]!, name, kind: "VIEW", viewDefinition: `select id from ${dependency}`, dependencies: [dependency] });
  snap.tables.push({ ...snap.tables[0]!, name: "async_task" });
  addView("public_tasks", "async_task");
  addView("nested_tasks", "public_tasks");
  addView("payroll_view", "user_weekly_salary");
  addView("nested_payroll", "payroll_view");
  addView("member_view", "user");
  addView("foreign_view", "otherdb.user");
  addView("cycle_a", "cycle_b"); addView("cycle_b", "cycle_a");
  for (const name of ["ASYNC_TASK", "public_tasks", "nested_tasks", "foreign_view", "cycle_a"]) assert.equal(tableAccess(name, snap), "denied");
  assert.equal(tableAccess("nested_payroll", snap), "admin");
  assert.equal(tableAccess("member_view", snap), "authenticated");
  const metadata = materializeMetadata(snap, semantic);
  assert.ok(!metadata.entities.some(e => e.table === "public_tasks" || e.table === "nested_tasks"));
  assert.equal(metadata.entities.find(e => e.table === "nested_payroll")!.access, "admin");
});

test("sync publishes all eligible tables; catalog, describe and query enforce the same role matrix", async t => {
  const { dir, config } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const snap = structuredClone(schema);
  for (const table of [...DENIED_TABLES, ...ADMIN_TABLES, "copilot_record", "docs_copy1"]) {
    if (!snap.tables.some(t => t.name === table)) snap.tables.push({ ...structuredClone(snap.tables[2]!), name: table });
  }
  snap.tables[0]!.columns.push({ ...snap.tables[0]!.columns[1]!, name: "password", ordinal: 3 });
  const queries: string[] = [];
  const service = new OaReadService(config, fakeDatabase(() => snap, queries));
  t.after(() => service.close());
  const report = await service.sync("test"); assert.equal(report.status, "published");
  assert.ok(!queries.some(q => q.includes("FROM `async_task`")));
  const active = (await readCatalogState(dir))!.active!;
  assert.ok(!active.semantic.entities.find(e => e.name === "members")!.columns.password);
  assert.equal(active.semantic.entities.find(e => e.name === "members")!.access, "authenticated");
  for (const isAdmin of [false, true]) {
    const user = { ...principal, isAdmin };
    const catalog = await service.call({ action: "catalog" }, user);
    assert.equal(catalog.ok, true);
    for (const table of [...DENIED_TABLES, ...ADMIN_TABLES, "user", "copilot_record", "docs_copy1"]) {
      const name = active.semantic.entities.find(e => e.table === table)?.name ?? table;
      const allowed = !DENIED_TABLES.has(table) && (!ADMIN_TABLES.has(table) || isAdmin);
      assert.equal((catalog as any).entities.some((e: any) => e.name === name), allowed, `${isAdmin}:${table}:catalog`);
      assert.equal((await service.call({ action: "describe", entities: [name] }, user)).ok, allowed);
      const before = queries.length;
      assert.equal((await service.call({ action: "query", version: report.activeVersion, query: { from: { entity: name, as: "x" }, select: [{ aggregate: "count", as: "n" }] } }, user)).ok, allowed);
      if (!allowed) assert.equal(queries.length, before);
    }
  }
});

test("type drift requires semantic review; new non-credential fields publish automatically", async t => {
  const { dir, config } = await fixture(); t.after(() => rm(dir, { recursive: true, force: true }));
  const current = structuredClone(schema); const db = fakeDatabase(() => current);
  await synchronizeMetadata(config, db, "startup");
  current.tables[0]!.columns[1]!.type = "text";
  assert.equal((await synchronizeMetadata(config, db, "scheduled")).status, "rejected");
  const revised = structuredClone(semantic); revised.entities[0]!.columns.name!.description = "Reviewed text field";
  await writeFile(config.metadataPath, JSON.stringify(revised));
  assert.equal((await synchronizeMetadata(config, db, "manual")).status, "published");
  current.tables[0]!.columns.push({ ...current.tables[0]!.columns[0]!, name: "new_sensitive_field", ordinal: 3 });
  assert.equal((await synchronizeMetadata(config, db, "scheduled")).status, "published");
  const state = (await readCatalogState(dir))!;
  assert.ok(state.active!.semantic.entities[0]!.columns.new_sensitive_field);
});

test("malformed semantic updates fail closed without replacing the last good catalog", async t => {
  const { dir, config } = await fixture(); t.after(() => rm(dir, { recursive: true, force: true }));
  const db = fakeDatabase(() => schema);
  const first = await synchronizeMetadata(config, db, "startup");
  await writeFile(config.metadataPath, "invalid");
  assert.equal((await synchronizeMetadata(config, db, "manual")).status, "rejected");
  assert.equal((await readCatalogState(dir))!.active!.version, first.activeVersion);
});

test("chat catalog/describe/query never scans information_schema and enforces version/scope", async t => {
  const { dir, config } = await fixture(); t.after(() => rm(dir, { recursive: true, force: true }));
  const queries: string[] = []; const db = fakeDatabase(() => schema, queries);
  const first = await synchronizeMetadata(config, db, "startup"); queries.length = 0;
  const service = new OaReadService(config, db); t.after(() => service.close());
  const catalog = await service.call({ action: "catalog" }, principal);
  assert.ok(!JSON.stringify(catalog).includes('"name":"salaries"'));
  assert.equal((await service.call({ action: "describe", entities: ["salaries"] }, principal)).ok, false);
  assert.equal((await service.call({ action: "query", version: "old", query: basic }, principal)).ok, false);
  assert.equal((await service.call({ action: "query", version: first.activeVersion, query: basic }, principal)).ok, true);
  assert.equal(queries.length, 1); assert.ok(!queries[0]!.includes("information_schema"));
});

test("OA reads move to database routing, writes and knowledge routes remain", () => {
  const index = buildOpenApiIndex({ paths: { "/projects": { get: { operationId: "list_projects" }, post: { operationId: "create_project" } }, "/search": { post: { operationId: "search_projects" } } } });
  const result = withDatabaseReadRouting(index);
  assert.deepEqual(result.operations.map(o => o.operationId), ["create_project", "oa_database_read"]);
  assert.equal(isOaReadOperation("POST", "admin_query_users", "/admin/query", "查询"), true);
  assert.match(databaseReadGuidance(""), /不能用项目最新 updated_at/);
  assert.notEqual(readToolToken("secret", "session-a"), readToolToken("secret", "session-b"));
});

test("read API calls are stopped server-side while confirmed writes retain the API path", async t => {
  const { callOaApiTool } = await import("../src/infrastructure/oa/oaApiTool.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "oa-read-route-")); t.after(() => rm(dir, { recursive:true, force:true }));
  const openapiPath = path.join(dir, 'openapi.json');
  const document = { openapi: '3.0.0', paths: { '/projects': { get: { operationId: 'read_route_projects_get' }, post: { operationId: 'read_route_create_project' } } } };
  await writeFile(openapiPath, JSON.stringify(document));
  const originalFetch=globalThis.fetch;
  let businessCalls=0;
  globalThis.fetch=async input=>{
    if(String(input)==='https://oa-route.test/openapi')return Response.json(document);
    businessCalls++; return Response.json({success:true});
  };
  t.after(()=>{globalThis.fetch=originalFetch;});
  const config={ projectRoot:dir, openapiPath, openapiUrl:'https://oa-route.test/openapi', oaApiBaseUrl:'https://oa-route.test', oaAuthAlias:'default', oaApiTokenHeader:'Cookie', oaApiTokenPrefix:'sessionid=', oaRead:{databaseUrl:'mysql://r:p@db/oa'} } as any;
  const read=await callOaApiTool(config,{operationId:'read_route_projects_get'},'user-token');
  assert.equal(read.error?.code,'oa_read_requires_database');assert.equal(businessCalls,0);
  const write=await callOaApiTool(config,{operationId:'read_route_create_project',confirmed:true},'user-token');
  assert.equal(write.ok,true);assert.equal(businessCalls,1);
});

test("text chunks are bounded and metadata publication timestamps do not change on periodic checks", async t => {
  const query = compileQuery({from:{entity:'members',as:'m'},select:[{field:'m.name',as:'content',textOffset:6000,textLength:2000}]},published,principal,100,1000);
  assert.match(query.sql,/SUBSTRING\(CAST\(`m`.`name` AS CHAR\), 6001, 2000\)/);
  const {dir,config}=await fixture();t.after(()=>rm(dir,{recursive:true,force:true}));
  const db=fakeDatabase(()=>schema);
  await synchronizeMetadata(config,db,'startup');
  const first=(await readCatalogState(dir))!.active!;
  const archive=await readFile(path.join(dir,'versions',`${first.version}.json`),'utf8');
  await synchronizeMetadata(config,db,'scheduled');
  assert.equal((await readCatalogState(dir))!.active!.publishedAt,first.publishedAt);
  assert.equal(await readFile(path.join(dir,'versions',`${first.version}.json`),'utf8'),archive);
});

test("concurrent synchronizers cannot publish over each other", async t => {
  const {dir,config}=await fixture();t.after(()=>rm(dir,{recursive:true,force:true}));
  const { mkdir }=await import('node:fs/promises');
  await mkdir(path.join(dir,'sync.lock'));
  await assert.rejects(synchronizeMetadata(config,fakeDatabase(()=>schema),'manual'),/metadata_sync_busy/);
  assert.equal(await readCatalogState(dir),null);
});

test("background polling discovers table/column additions and varchar widening without a hook", async t => {
  const { dir, config } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const current = structuredClone(schema);
  const queries: string[] = [];
  const service = new OaReadService(config, fakeDatabase(() => current, queries));
  t.after(() => service.close());
  await Promise.all([service.start(), service.start()]);
  const first = (await readCatalogState(dir))!.active!.version;
  current.tables.push({ ...structuredClone(current.tables[2]!), name: "new_table" });
  current.tables[0]!.columns.push({ ...current.tables[0]!.columns[0]!, name: "added_column", ordinal: 3 });
  current.tables[0]!.columns[1]!.type = "varchar(512)";
  t.mock.timers.tick(config.syncIntervalSeconds * 1000 - 1);
  assert.equal((await readCatalogState(dir))!.active!.version, first);
  t.mock.timers.tick(1);
  // Join the already-running timer operation; the persisted trigger proves it
  // was started by the timer, not this join or an external migration hook.
  await service.sync("test_join");
  const state = (await readCatalogState(dir))!;
  assert.equal(state.report.trigger, "scheduled");
  assert.equal(state.report.status, "published");
  assert.notEqual(state.active!.version, first);
  assert.ok(state.report.changes.some(c => c.table === "new_table" && c.kind === "added"));
  assert.ok(state.report.changes.some(c => c.field === "added_column" && c.kind === "added"));
  assert.equal(state.active!.schema.tables[0]!.columns[1]!.type, "varchar(512)");
  assert.ok(state.active!.semantic.entities[0]!.columns.added_column);
  await service.close();
  const count = queries.length;
  t.mock.timers.tick(config.syncIntervalSeconds * 2000);
  assert.equal(queries.length, count);
});

test("background checks retry initial failures and recover after a removed field is restored", async t => {
  const { dir, config } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setInterval"] });
  let current = structuredClone(schema);
  let available = false;
  const service = new OaReadService(config, fakeDatabase(() => {
    if (!available) throw new Error("connection unavailable");
    return current;
  }));
  t.after(() => service.close());
  const tick = async () => {
    t.mock.timers.tick(config.syncIntervalSeconds * 1000);
    await service.sync("test_join");
    const state = (await readCatalogState(dir))!;
    assert.equal(state.report.trigger, "scheduled");
    return state;
  };
  await service.start();
  assert.equal((await readCatalogState(dir))!.report.status, "rejected");
  available = true;
  const healthy = await tick();
  assert.equal(healthy.report.status, "published");
  current.tables[0]!.columns.pop();
  const broken = await tick();
  assert.equal(broken.report.status, "rejected");
  assert.equal(broken.active!.version, healthy.active!.version);
  assert.equal((await service.call({ action: "catalog" }, principal)).ok, false);
  current = structuredClone(schema);
  assert.equal((await tick()).report.status, "unchanged");
  assert.equal((await service.call({ action: "catalog" }, principal)).ok, true);
});
