import { DatabaseSync } from "node:sqlite";

interface LocalDurableObject {
  fetch(request: Request): Promise<Response>;
  alarm?: () => Promise<void>;
}

interface LocalDurableObjectEntry {
  object: LocalDurableObject;
  sqlite: DatabaseSync;
  alarm: {
    scheduled: boolean;
    running: boolean;
    at: number | null;
    timer: ReturnType<typeof setTimeout> | null;
  };
}

/**
 * 本機 node:http 沒有 Durable Object runtime。這個 adapter 只補開發所需的 getByName、
 * SQLite storage 與 alarm；正式環境仍完全使用 Cloudflare Durable Objects。
 */
export class LocalDurableObjectNamespace {
  private readonly entries = new Map<string, LocalDurableObjectEntry>();

  constructor(
    private readonly createObject: (state: DurableObjectState) => LocalDurableObject,
  ) {}

  getByName(name: string): DurableObjectStub {
    let entry = this.entries.get(name);
    if (!entry) {
      const sqlite = new DatabaseSync(":memory:");
      const alarm = {
        scheduled: false,
        running: false,
        at: null as number | null,
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      const storage = {
        sql: {
          exec: (query: string, ...bindings: unknown[]) => {
            if (!bindings.length && query.includes(";")) {
              sqlite.exec(query);
              return [];
            }
            return sqlite.prepare(query).all(...bindings as never[]);
          },
        },
        getAlarm: async () => alarm.at,
        setAlarm: async (at: number) => {
          alarm.scheduled = true;
          alarm.at = at;
        },
        deleteAlarm: async () => {
          alarm.scheduled = false;
          alarm.at = null;
          if (alarm.timer) {
            clearTimeout(alarm.timer);
            alarm.timer = null;
          }
        },
      };
      const state = {
        storage,
        blockConcurrencyWhile: (initialize: () => Promise<void>) => {
          void initialize();
        },
      } as unknown as DurableObjectState;
      entry = { object: this.createObject(state), sqlite, alarm };
      this.entries.set(name, entry);
    }

    const current = entry;
    return {
      fetch: async (request: Request) => {
        const response = await current.object.fetch(request);
        this.scheduleAlarm(current);
        return response;
      },
    } as DurableObjectStub;
  }

  private scheduleAlarm(entry: LocalDurableObjectEntry): void {
    if (!entry.alarm.scheduled || entry.alarm.running || !entry.object.alarm) return;
    if (entry.alarm.timer) clearTimeout(entry.alarm.timer);
    const delay = Math.max(0, (entry.alarm.at ?? Date.now()) - Date.now());
    entry.alarm.timer = setTimeout(() => {
      entry.alarm.timer = null;
      if (!entry.alarm.scheduled || entry.alarm.running) return;
      if ((entry.alarm.at ?? Date.now()) > Date.now()) {
        this.scheduleAlarm(entry);
        return;
      }
      entry.alarm.scheduled = false;
      entry.alarm.at = null;
      entry.alarm.running = true;
      void entry.object.alarm!()
        .catch((error) => console.error("本機 Pi Agent alarm 執行失敗", error))
        .finally(() => {
          entry.alarm.running = false;
          this.scheduleAlarm(entry);
        });
    }, delay);
  }

  close(): void {
    for (const entry of this.entries.values()) {
      if (entry.alarm.timer) clearTimeout(entry.alarm.timer);
      entry.sqlite.close();
    }
    this.entries.clear();
  }
}
