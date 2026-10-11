/**
 * The plugin's durable state: the order (OrderState) and the sub-agent tasks that replace the old A2A tasks.
 * One JSON file, rewritten atomically after every change, so a gateway restart keeps the order, the tasks, the
 * questions waiting for the user and their answers.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SubAgentName } from '../core/agents.js';
import type {
  ErrorCode,
  ExecuteRequest,
  ExecuteResult,
  ExploreRequest,
  ProductListUpdate,
  QaRequest,
  QaResult,
  Selection,
} from '../core/contracts.js';
import type { ProductListChange } from '../core/explore/product-list.js';
import { OrderState, type OrderStateSnapshot } from '../core/order-state.js';

export type SubAgentRequest = ExploreRequest | ExecuteRequest | QaRequest;
export type TaskResult = Selection | ProductListUpdate | ExecuteResult | QaResult;

/**
 * created: waiting for COS's sessions_spawn. running: a child run works on it. input-required: the child asked
 * the user (poo_ask_user) and ended its run. answered: COS stored the user's answer, not yet delivered to the child.
 */
export type TaskState = 'created' | 'running' | 'input-required' | 'answered' | 'completed' | 'failed' | 'canceled';

export interface QuestionRecord {
  question: string;
  askedAt: string;
  /** When COS sent it to the user: a message the user wrote earlier is not an answer to it. */
  relayedAt?: string;
  answer?: string;
  answeredAt?: string;
  /** When the answer went back to the child. */
  deliveredAt?: string;
}

export interface TaskError {
  code: ErrorCode;
  message: string;
  hint?: string;
}

export interface TaskRecord {
  id: string;
  agent: SubAgentName;
  orderId: string;
  request: SubAgentRequest;
  /** COS's plain-language instruction (user wishes, context). */
  instruction: string;
  state: TaskState;
  /** The child session that works on the task (kept after its runs end, so it can be continued). */
  childSessionKey?: string;
  runId?: string;
  spawns: number;
  questions: QuestionRecord[];
  /** Explore update-product-list: every change applied to the skill. */
  listChanges: ProductListChange[];
  result?: TaskResult;
  /** One-paragraph outcome for COS. */
  summary?: string;
  error?: TaskError;
  createdAt: string;
  updatedAt: string;
}

const ACTIVE: ReadonlySet<TaskState> = new Set(['created', 'running', 'input-required', 'answered']);
/** Finished tasks of earlier orders kept for the record. */
const KEEP_FINISHED = 50;

interface StoreData {
  version: 1;
  order: OrderStateSnapshot;
  tasks: TaskRecord[];
}

export class Store {
  order: OrderState;
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(
    readonly file: string,
    shopId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    const data = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as StoreData) : undefined;
    if (data && data.version !== 1) throw new Error(`${file}: unsupported state version ${String(data.version)}`);
    this.order = data && data.order.shopId === shopId ? OrderState.fromSnapshot(data.order) : new OrderState(shopId);
    for (const task of data?.tasks ?? []) this.tasks.set(task.id, task);
  }

  timestamp(): string {
    return this.now().toISOString();
  }

  /** Run a change and persist it. */
  update<T>(change: () => T): T {
    const out = change();
    this.save();
    return out;
  }

  createTask(agent: SubAgentName, request: SubAgentRequest, instruction: string): TaskRecord {
    const at = this.timestamp();
    const task: TaskRecord = {
      id: `${agent}-${randomBytes(4).toString('hex')}`,
      agent,
      orderId: this.order.orderId,
      request,
      instruction,
      state: 'created',
      spawns: 0,
      questions: [],
      listChanges: [],
      createdAt: at,
      updatedAt: at,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  task(id: string): TaskRecord | undefined {
    return this.tasks.get(id.trim());
  }

  taskBySession(sessionKey: string | undefined): TaskRecord | undefined {
    if (!sessionKey) return undefined;
    let found: TaskRecord | undefined;
    for (const task of this.tasks.values()) if (task.childSessionKey === sessionKey) found = task; // the latest wins
    return found;
  }

  /** Tasks of the current order, oldest first. */
  orderTasks(): TaskRecord[] {
    return [...this.tasks.values()].filter((t) => t.orderId === this.order.orderId);
  }

  activeTasks(): TaskRecord[] {
    return [...this.tasks.values()].filter((t) => ACTIVE.has(t.state));
  }

  touch(task: TaskRecord, patch: Partial<TaskRecord>): TaskRecord {
    Object.assign(task, patch, { updatedAt: this.timestamp() });
    return task;
  }

  /** The question the child asked last, while it waits for the user. */
  openQuestion(task: TaskRecord): QuestionRecord | undefined {
    const last = task.questions.at(-1);
    return last && !last.deliveredAt ? last : undefined;
  }

  isActive(task: TaskRecord): boolean {
    return ACTIVE.has(task.state);
  }

  private save(): void {
    const finishedOld = [...this.tasks.values()].filter((t) => !ACTIVE.has(t.state) && t.orderId !== this.order.orderId);
    for (const task of finishedOld.slice(0, Math.max(0, finishedOld.length - KEEP_FINISHED))) this.tasks.delete(task.id);
    const data: StoreData = { version: 1, order: this.order.snapshot(), tasks: [...this.tasks.values()] };
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
