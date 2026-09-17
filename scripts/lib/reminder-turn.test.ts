import assert from "node:assert/strict";
import test from "node:test";
import {
  ReminderTurnError,
  runReminderTurn,
  type CreateClient,
  type ReminderClient,
  type ReminderClientOptions,
  type TurnStreamEvent,
} from "./reminder-turn.ts";

const OPTIONS: ReminderClientOptions = {
  host: "http://127.0.0.1:8723",
  auth: { bearer: () => Promise.resolve("bearer") },
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

type TurnSpy = {
  readonly createClient: CreateClient;
  readonly prompts: string[];
  readonly sent: string[];
  readonly resets: string[];
  readonly cancelCount: () => number;
};

// A turn reads its response as a stream and cancels it cooperatively, the way eve's
// MessageResponse does; the session records what the turn told it to do.
function spyTurn(
  events: (cancelled: Promise<void>) => AsyncGenerator<TurnStreamEvent>,
): TurnSpy {
  const prompts: string[] = [];
  const sent: string[] = [];
  const resets: string[] = [];
  let cancels = 0;
  let releaseCancel = (): void => {};
  const cancelled = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  const response = Object.assign(events(cancelled), {
    cancel: () => {
      cancels += 1;
      releaseCancel();
      return Promise.resolve();
    },
  });
  const client: ReminderClient = {
    sessions: {
      create: (input) => {
        prompts.push(input.message);
        return Promise.resolve({
          response,
          session: {
            send: (message) => {
              sent.push(message);
              return Promise.resolve();
            },
            reset: ({ reason }) => {
              resets.push(reason);
              return Promise.resolve();
            },
          },
        });
      },
    },
  };
  return {
    createClient: () => Promise.resolve(client),
    prompts,
    sent,
    resets,
    cancelCount: () => cancels,
  };
}

function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

void test("the last message.completed text is returned and the session is reset", async () => {
  const spy = spyTurn(async function* () {
    // Each gap stays under the idle window while the whole turn runs past it: a window that
    // is only armed once, instead of once per event, has to cut this stream off.
    for (const event of [
      { type: "step.started" },
      { type: "message.appended" },
      { type: "message.completed", data: { message: "draft" } },
      { type: "message.completed", data: { message: null } },
      { type: "message.completed", data: { message: "final" } },
      { type: "reasoning.appended" },
      { type: "action.result" },
      { type: "session.waiting" },
    ] as const) {
      await delay(40);
      yield event;
    }
  });

  const turn = await runReminderTurn("сформулируй напоминание", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 200,
  });

  assert.deepEqual(spy.prompts, ["сформулируй напоминание"]);
  assert.equal(turn.status, "waiting");
  assert.equal(turn.message, "final");
  await turn.feedback("hint");
  assert.deepEqual(spy.sent, ["hint"]);
  assert.deepEqual(spy.resets, ["Reminder finished"]);
});

void test("a silent stream is cancelled at the idle window, never swallowed", async () => {
  const silent = spyTurn(async function* (cancelled) {
    await delay(40);
    yield { type: "step.started" };
    // The turn hangs here; the window has to cut the silence, and cancel() is the only
    // thing that ends the wait.
    await Promise.race([cancelled, delay(400)]);
  });

  const idle = await failureOf(
    runReminderTurn("зависни", OPTIONS, {
      createClient: silent.createClient,
      inactivityMs: 80,
      hardTimeoutMs: 10_000,
    }),
  );

  assert.ok(idle instanceof ReminderTurnError);
  assert.match(idle.message, /no activity for 80ms/u);
  assert.equal(silent.cancelCount(), 1);
  assert.deepEqual(silent.resets, ["Reminder finished"]);

  const talkative = spyTurn(async function* () {
    // Events keep coming faster than the idle window, so only the cap can end this turn;
    // the stream stops by itself after the cap, so a broken cap fails instead of hanging.
    for (let count = 0; count < 40; count += 1) {
      await delay(5);
      yield { type: "step.started" };
    }
  });

  const capped = await failureOf(
    runReminderTurn("говори без конца", OPTIONS, {
      createClient: talkative.createClient,
      inactivityMs: 1_000,
      hardTimeoutMs: 50,
    }),
  );

  assert.ok(capped instanceof ReminderTurnError);
  assert.match(capped.message, /turn exceeded 50ms/u);
  assert.equal(talkative.cancelCount(), 1);
  assert.deepEqual(talkative.resets, ["Reminder finished"]);
});
