/**
 * Behavioral tests for background.js's conversation routing: fresh always
 * opens Temporary Chat, continue resolves the exact live tab by
 * conversation.id + expected_turn_id (never a locator/URL), a lost session
 * never reopens a replacement tab, and archive/cleanup only ever touch the
 * exact conversation they were asked about.
 *
 * background.js runs as a plain script (no DOM) inside a Node `vm` context
 * with a minimal in-memory mock of the chrome.* APIs it touches. Top-level
 * `const`/`function` declarations in a script run via `vm.runInContext`
 * remain visible to later `runInContext` calls against the same context —
 * the same pattern `content-dom.test.js` uses to reach into content.js.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const EXTENSION = path.join(__dirname, "..", "extension");
const BACKGROUND_SOURCE = fs.readFileSync(path.join(EXTENSION, "background.js"), "utf8");

function createFakeWebSocket() {
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.closeCalls = (this.closeCalls || 0) + 1;
    }
  }
  FakeWebSocket.instances = [];
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  return FakeWebSocket;
}

function makeFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const callbacks = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      pending.set(id, { callback, delay });
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    pending,
    fire(id, { evenIfCleared = false } = {}) {
      const timer = pending.get(id);
      if (!timer && !evenIfCleared) throw new Error(`Timer ${id} is not pending`);
      pending.delete(id);
      callbacks.get(id)?.();
    },
  };
}

/** In-memory chrome.* mock: tabs are a real Map so tests can assert on them
 * directly, storage.session/local are plain objects a test can inspect. */
function makeChromeMock() {
  let nextTabId = 1;
  let nextWindowId = 900;
  const tabsById = new Map();
  const windowsById = new Map();
  const sessionStore = {};
  const localStore = {};
  const removedListeners = [];
  const updatedListeners = [];
  const messageListeners = [];
  const windowRemovedListeners = [];
  const windowCreateCalls = [];

  /** L'opérateur a une fenêtre normale focalisée, comme dans la vraie vie. */
  const userWindow = { id: nextWindowId++, type: "normal", focused: true, state: "normal" };
  windowsById.set(userWindow.id, userWindow);

  const chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: sessionStore[key] }),
        set: async (obj) => {
          Object.assign(sessionStore, obj);
        },
      },
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const result = {};
          for (const key of list) result[key] = localStore[key];
          return result;
        },
        set: async (obj) => {
          Object.assign(localStore, obj);
        },
      },
    },
    tabs: {
      create: async ({ url, active, windowId }) => {
        const tab = {
          id: nextTabId++,
          url,
          windowId: windowId ?? userWindow.id,
          status: "complete",
          active: !!active,
        };
        tabsById.set(tab.id, tab);
        return { ...tab };
      },
      get: async (tabId) => {
        const tab = tabsById.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return { ...tab };
      },
      query: async (filter = {}) =>
        [...tabsById.values()]
          .filter((tab) => filter.windowId === undefined || tab.windowId === filter.windowId)
          .map((tab) => ({ ...tab })),
      remove: async (tabId) => {
        const existed = tabsById.has(tabId);
        tabsById.delete(tabId);
        if (existed) {
          for (const fn of removedListeners) fn(tabId);
        }
      },
      sendMessage: async () => ({}),
      update: async (tabId, props) => {
        const tab = tabsById.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        Object.assign(tab, props);
        return { ...tab };
      },
      onRemoved: { addListener: (fn) => removedListeners.push(fn) },
      onUpdated: { addListener: (fn) => updatedListeners.push(fn) },
      reload: async () => {},
    },
    windows: {
      create: async (options) => {
        windowCreateCalls.push({ ...options });
        const window = {
          id: nextWindowId++,
          type: options.type ?? "normal",
          focused: options.focused === true,
          state: options.state ?? "normal",
        };
        windowsById.set(window.id, window);
        const urls = Array.isArray(options.url) ? options.url : [options.url];
        const tabs = urls.map((url, index) => {
          const tab = {
            id: nextTabId++,
            url,
            windowId: window.id,
            status: "complete",
            // Chrome rend actif le premier onglet de la nouvelle fenêtre,
            // même quand celle-ci n'est pas focalisée.
            active: index === 0,
          };
          tabsById.set(tab.id, tab);
          return { ...tab };
        });
        return { ...window, tabs };
      },
      get: async (windowId, options = {}) => {
        const window = windowsById.get(windowId);
        if (!window) throw new Error(`No window with id: ${windowId}`);
        if (!options.populate) return { ...window };
        const tabs = [...tabsById.values()]
          .filter((tab) => tab.windowId === windowId)
          .map((tab) => ({ ...tab }));
        return { ...window, tabs };
      },
      remove: async (windowId) => {
        if (!windowsById.has(windowId)) throw new Error(`No window with id: ${windowId}`);
        windowsById.delete(windowId);
        for (const tab of [...tabsById.values()]) {
          if (tab.windowId === windowId) await chrome.tabs.remove(tab.id);
        }
        for (const fn of windowRemovedListeners) fn(windowId);
      },
      onRemoved: { addListener: (fn) => windowRemovedListeners.push(fn) },
    },
    scripting: { executeScript: async () => {} },
    runtime: {
      getManifest: () => ({ version: "1.2.3" }),
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  };

  return {
    chrome,
    tabsById,
    windowsById,
    userWindow,
    windowCreateCalls,
    sessionStore,
    localStore,
    removedListeners,
    updatedListeners,
    messageListeners,
  };
}

/** Loads background.js fresh into its own vm context. Passing the *same*
 * `chrome` mock (and therefore the same tabsById/sessionStore) across two
 * calls simulates a service-worker suspension/restart: browser-owned state
 * (tabs, chrome.storage.session) survives, in-memory module state doesn't. */
function loadBackground(chrome, timers = { setTimeout, clearTimeout }) {
  const WebSocket = createFakeWebSocket();
  const sandbox = {
    chrome,
    console,
    URL,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    WebSocket,
    crypto: webcrypto,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(BACKGROUND_SOURCE, context, { filename: "background.js" });
  return {
    run: (expression) => vm.runInContext(expression, context),
    WebSocket,
    webSockets: WebSocket.instances,
  };
}

async function makeTransportHarness() {
  const mock = makeChromeMock();
  const timers = makeFakeTimers();
  const loaded = loadBackground(mock.chrome, timers);
  // background.js starts connect() at load; let its storage promises settle.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loaded.webSockets.length, 1, "startup creates one WebSocket");
  return { ...loaded, mock, timers };
}

function openFakeSocket(socket, WebSocket) {
  socket.readyState = WebSocket.OPEN;
  socket.onopen();
}

async function main() {
  assert.doesNotMatch(
    BACKGROUND_SOURCE,
    /chrome\.runtime\.onMessage\.addListener\(async/,
    "runtime.onMessage listener must remain synchronous",
  );

  // WebSocket callbacks belong to the instance that registered them. A late
  // 4000 close from A must not clear or mark a healthy current socket B down.
  {
    const { run, WebSocket, webSockets, timers } = await makeTransportHarness();
    const socketA = webSockets[0];
    openFakeSocket(socketA, WebSocket);
    run("staleSocketForTest = socket");
    socketA.readyState = WebSocket.CLOSING;

    // Reproduce an overlap where another path has released A and installed B.
    run("socket = null");
    await run("connect()");
    const socketB = run("socket");
    assert.notEqual(socketB, socketA);
    openFakeSocket(socketB, WebSocket);
    const suppressBefore = run("suppressUntil");
    const connectedBefore = run("status.connected");
    const lastErrorBefore = run("status.lastError");
    const timersBefore = timers.pending.size;

    socketA.readyState = WebSocket.CLOSED;
    socketA.onerror();
    socketA.onclose({ code: 4000 });

    assert.equal(run("socket"), socketB);
    assert.equal(socketB.readyState, WebSocket.OPEN);
    assert.equal(run("suppressUntil"), suppressBefore);
    assert.equal(run("status.connected"), connectedBefore);
    assert.equal(run("status.lastError"), lastErrorBefore);
    assert.equal(timers.pending.size, timersBefore, "stale callbacks add no reconnect timer");
    assert.equal(run("scheduleReconnect(staleSocketForTest, 'stale owner')"), false);
    assert.equal(run("socket"), socketB, "scheduleReconnect enforces owner identity itself");
    assert.equal(run("status.connected"), true);
    assert.equal(timers.pending.size, timersBefore);
  }

  // Extension identity survives reconnects and worker restarts. The worker
  // id is module-scoped, while each newly-created WebSocket gets a new id.
  {
    const mock = makeChromeMock();
    mock.localStore.wsToken = "test-ws-secret";
    const timers = makeFakeTimers();
    const first = loadBackground(mock.chrome, timers);
    await new Promise((resolve) => setImmediate(resolve));
    const socketA = first.webSockets[0];
    openFakeSocket(socketA, first.WebSocket);
    const helloA = JSON.parse(socketA.sent.find((text) => JSON.parse(text).type === "hello"));
    assert.equal(helloA.instance_id, mock.localStore.bridgeInstanceId);
    assert.ok(helloA.worker_session_id);
    assert.ok(helloA.connection_id);
    assert.equal(helloA.extension_version, "1.2.3");
    assert.equal(Object.hasOwn(helloA, "wsToken"), false);
    assert.equal(JSON.stringify(helloA).includes("test-ws-secret"), false);

    socketA.readyState = first.WebSocket.CLOSED;
    socketA.onclose({ code: 1006 });
    await first.run("connect()");
    const socketB = first.run("socket");
    openFakeSocket(socketB, first.WebSocket);
    const helloB = JSON.parse(socketB.sent.find((text) => JSON.parse(text).type === "hello"));
    assert.equal(helloB.instance_id, helloA.instance_id, "instance id is stable on reconnect");
    assert.equal(helloB.worker_session_id, helloA.worker_session_id, "worker id is stable in one worker");
    assert.notEqual(helloB.connection_id, helloA.connection_id, "connection id changes per socket");

    const restarted = loadBackground(mock.chrome, makeFakeTimers());
    await new Promise((resolve) => setImmediate(resolve));
    const socketC = restarted.webSockets[0];
    openFakeSocket(socketC, restarted.WebSocket);
    const helloC = JSON.parse(socketC.sent.find((text) => JSON.parse(text).type === "hello"));
    assert.equal(helloC.instance_id, helloA.instance_id, "instance id survives worker restart");
    assert.notEqual(helloC.worker_session_id, helloA.worker_session_id, "worker id changes on restart");
    assert.notEqual(helloC.connection_id, helloB.connection_id);
  }

  // send() queues during CLOSING and leaves reconnect ownership to A's close.
  {
    const { run, WebSocket, webSockets, timers } = await makeTransportHarness();
    const socketA = webSockets[0];
    openFakeSocket(socketA, WebSocket);
    run("enAttente.length = 0");
    socketA.readyState = WebSocket.CLOSING;

    run("send({ type: 'pong' })");
    await run("connect()");
    assert.equal(webSockets.length, 1, "CLOSING does not create a second socket");
    assert.equal(run("socket"), socketA);
    assert.deepEqual(JSON.parse(JSON.stringify(run("enAttente"))), [{ type: "pong" }]);
    assert.equal(timers.pending.size, 0);

    socketA.readyState = WebSocket.CLOSED;
    socketA.onclose({ code: 1006 });
    socketA.onclose({ code: 1006 });
    assert.equal(run("socket"), null);
    assert.equal(timers.pending.size, 1, "current close schedules only one reconnect");
  }

  // A canceled timer may already be queued by the event loop. Its generation
  // check must make it inert after B has become current and healthy.
  {
    const { run, WebSocket, webSockets, timers } = await makeTransportHarness();
    const socketA = webSockets[0];
    socketA.readyState = WebSocket.CLOSED;
    socketA.onclose({ code: 1006 });
    const [oldTimerId] = timers.pending.keys();
    assert.ok(oldTimerId);

    await run("connect()");
    const socketB = run("socket");
    openFakeSocket(socketB, WebSocket);
    assert.equal(timers.pending.size, 0, "new connection cancels the old timer");

    timers.fire(oldTimerId, { evenIfCleared: true });
    assert.equal(webSockets.length, 2, "stale timer does not create socket C");
    assert.equal(run("socket"), socketB);
    assert.equal(run("status.connected"), true);
  }

  // A current 4000 close owns the 60-second suppression. Sends during that
  // window queue without taking the connection back from the other client.
  {
    const { run, WebSocket, webSockets, timers } = await makeTransportHarness();
    const socketA = webSockets[0];
    openFakeSocket(socketA, WebSocket);
    socketA.readyState = WebSocket.CLOSED;
    socketA.onclose({ code: 4000 });
    const [timerId, timer] = [...timers.pending.entries()][0];

    assert.equal(run("socket"), null);
    assert.equal(run("status.connected"), false);
    assert.equal(run("suppressUntil - Date.now()"), 60000);
    assert.equal(timer.delay, 60000);
    run("send({ type: 'queued-during-suppression' })");
    assert.deepEqual(
      JSON.parse(JSON.stringify(run("enAttente"))),
      [{ type: "queued-during-suppression" }],
    );
    assert.equal(webSockets.length, 1, "send during suppression does not reconnect early");
    assert.deepEqual([...timers.pending.keys()], [timerId], "suppression timer remains the sole timer");
  }

  // A typed owner_active rejection uses the same backoff, avoiding connection
  // ping-pong when another healthy extension owns the lease.
  {
    const { run, WebSocket, webSockets, timers } = await makeTransportHarness();
    const socket = webSockets[0];
    openFakeSocket(socket, WebSocket);
    socket.readyState = WebSocket.CLOSED;
    socket.onclose({ code: 4409, reason: "owner_active" });
    assert.equal(run("suppressUntil - Date.now()"), 60000);
    assert.equal([...timers.pending.values()][0].delay, 60000);
  }

  // WebSocket race matrix, from the worker's point of view. Every state is
  // reported by connectionDiagnostic() without content, and none of them
  // produces a periodic replacement loop.
  {
    const connection = (run) => JSON.parse(JSON.stringify(run("connectionDiagnostic()")));

    // OPEN stable: keepalive alarms and server pings never create or close a socket.
    {
      const { run, WebSocket, webSockets, timers } = await makeTransportHarness();
      const socketA = webSockets[0];
      openFakeSocket(socketA, WebSocket);
      for (let tick = 0; tick < 20; tick += 1) {
        await run("connect()"); // chrome.alarms "keepalive" listener
        socketA.onmessage({ data: JSON.stringify({ type: "ping", t: tick }) });
      }
      assert.equal(webSockets.length, 1, "OPEN stable: no replacement socket");
      assert.equal(socketA.closeCalls || 0, 0, "OPEN stable: never closed by the worker");
      assert.equal(timers.pending.size, 0, "OPEN stable: no reconnect timer");
      const state = connection(run);
      assert.equal(state.state, "stable");
      assert.equal(state.reconnections, 0);
      assert.equal(state.seconds_since_ping, 0);
      const hello = JSON.parse(socketA.sent.find((text) => JSON.parse(text).type === "hello"));
      assert.equal(state.instance_id_prefix, hello.instance_id.slice(0, 8));
      assert.equal(state.worker_session_prefix, hello.worker_session_id.slice(0, 8));
      assert.equal(state.connection_id_prefix, hello.connection_id.slice(0, 8));
      assert.equal(JSON.stringify(state).includes(hello.instance_id), false, "only id prefixes");
      assert.equal(
        socketA.sent.filter((text) => JSON.parse(text).type === "pong").length,
        20,
        "each ping gets exactly one pong",
      );
    }

    // CONNECTING: alarms during the handshake do not open a second socket.
    {
      const { run, webSockets, timers } = await makeTransportHarness();
      for (let tick = 0; tick < 5; tick += 1) await run("connect()");
      assert.equal(webSockets.length, 1, "CONNECTING: one socket only");
      assert.equal(timers.pending.size, 0);
      assert.equal(connection(run).state, "connecting");
    }

    // Stale: an OPEN socket with no ping for more than 60 s is reported stale,
    // but the worker does not tear it down itself (the server owns that verdict).
    {
      const { run, WebSocket, webSockets } = await makeTransportHarness();
      const socketA = webSockets[0];
      openFakeSocket(socketA, WebSocket);
      run("globalThis.__realNow = Date.now; globalThis.__t0 = Date.now()");
      socketA.onmessage({ data: JSON.stringify({ type: "ping" }) });
      run("Date.now = () => __t0 + 61000");
      const state = connection(run);
      run("Date.now = __realNow");
      assert.equal(state.state, "stale");
      assert.ok(state.seconds_since_ping >= 61);
      assert.equal(webSockets.length, 1);
      assert.equal(socketA.closeCalls || 0, 0);
    }

    // 4000 on the current socket: conflict(replaced), and alarms during the
    // suppression window never take the connection back.
    {
      const { run, WebSocket, webSockets } = await makeTransportHarness();
      const socketA = webSockets[0];
      openFakeSocket(socketA, WebSocket);
      socketA.readyState = WebSocket.CLOSED;
      socketA.onclose({ code: 4000 });
      for (let tick = 0; tick < 5; tick += 1) await run("connect()");
      assert.equal(webSockets.length, 1, "no reconnect during suppression");
      const state = connection(run);
      assert.equal(state.state, "conflict");
      assert.equal(state.conflict_reason, "replaced");
      assert.equal(state.connection_id_prefix, null);
    }

    // Two instances: owner_active is a typed conflict. Each retry waits the
    // full backoff, so a contender makes at most one attempt per 60 s and
    // never replaces anyone.
    {
      const { run, WebSocket, webSockets, timers } = await makeTransportHarness();
      let rejected = 0;
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const current = webSockets[webSockets.length - 1];
        openFakeSocket(current, WebSocket);
        current.readyState = WebSocket.CLOSED;
        current.onclose({ code: 4409, reason: "owner_active" });
        rejected += 1;
        assert.equal(connection(run).state, "conflict");
        assert.equal(connection(run).conflict_reason, "owner_active");
        assert.equal(timers.pending.size, 1, "exactly one pending retry");
        const [[timerId, timer]] = [...timers.pending.entries()];
        assert.equal(timer.delay, 60000, "retry honours the owner_active backoff");
        run("suppressUntil = 0"); // the 60 s have elapsed
        timers.fire(timerId);
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(webSockets.length, rejected + 1, "one attempt per backoff window");
      for (const old of webSockets.slice(0, -1)) {
        assert.equal(old.closeCalls || 0, 0, "the contender never closes anyone");
      }
    }

    // Reconnect after a plain drop: the counter and connection id move, the
    // instance and worker session stay; the stale close of A changes nothing.
    {
      const { run, WebSocket, webSockets, timers } = await makeTransportHarness();
      const socketA = webSockets[0];
      openFakeSocket(socketA, WebSocket);
      const before = connection(run);
      socketA.readyState = WebSocket.CLOSED;
      socketA.onclose({ code: 1006 });
      assert.equal(connection(run).state, "disconnected");
      const [timerId] = timers.pending.keys();
      timers.fire(timerId);
      await new Promise((resolve) => setImmediate(resolve));
      const socketB = webSockets[1];
      openFakeSocket(socketB, WebSocket);
      socketA.onclose({ code: 1006 });
      socketA.onerror();
      const after = connection(run);
      assert.equal(after.state, "stable");
      assert.equal(after.reconnections, 1);
      assert.equal(after.instance_id_prefix, before.instance_id_prefix);
      assert.equal(after.worker_session_prefix, before.worker_session_prefix);
      assert.notEqual(after.connection_id_prefix, before.connection_id_prefix);
      assert.equal(webSockets.length, 2);
      assert.equal(timers.pending.size, 0);
    }

    // The status message the popup polls carries the same safe connection block.
    {
      const { WebSocket, webSockets, mock } = await makeTransportHarness();
      openFakeSocket(webSockets[0], WebSocket);
      const response = await new Promise((resolve) => {
        for (const listener of mock.messageListeners) listener({ type: "status" }, {}, resolve);
      });
      assert.equal(response.connected, true);
      assert.equal(response.connection.state, "stable");
      assert.equal(JSON.stringify(response).includes("token"), false);
    }
  }

  // 1. FRESH A creates exactly one inactive tab at the Temporary Chat URL.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tab = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');

    assert.equal(tab.url, "https://chatgpt.com/?temporary-chat=true");
    // Actif dans sa fenêtre dédiée, mais cette fenêtre n'est pas focalisée.
    assert.equal(tab.active, true);
    assert.notEqual(tab.windowId, mock.userWindow.id);
    assert.equal(mock.windowsById.get(tab.windowId).focused, false);
    assert.equal(mock.userWindow.focused, true, "la fenêtre de l'opérateur garde le focus");
    assert.equal(mock.tabsById.size, 1);
  }

  // 1b. UI preflight and the first prompt share the reserved fresh tab; a
  // second prompt after submission is refused without opening another tab.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const first = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    const preflight = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    assert.equal(preflight.id, first.id);
    await run('conversationRegistry.set("conv-A", { ...conversationRegistry.get("conv-A"), state: "live" })');
    await assert.rejects(
      run('resolveConversationTab({ mode: "fresh", id: "conv-A" })'),
      (err) => err.code === "conversation_unavailable",
    );
    assert.equal(mock.tabsById.size, 1);
  }

  // 2. FRESH A persists A -> tab_id in chrome.storage.session.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tab = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');

    const stored = mock.sessionStore.bridgeConversationRegistry;
    assert.ok(stored, "bridgeConversationRegistry must be persisted to storage.session");
    assert.equal(stored["conv-A"].tab_id, tab.id);
    assert.equal(mock.localStore.bridgeConversationRegistry, undefined);
  }

  // 3. Service-worker reinitialization: storage.session survives, CONTINUE A
  //    with a matching expected_turn_id reuses the exact same tab.
  {
    const mock = makeChromeMock();
    const first = loadBackground(mock.chrome);
    const tabA = await first.run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    await first.run(
      `conversationRegistry.set("conv-A", { tab_id: ${tabA.id}, window_id: ${tabA.windowId}, head_turn_id: "turn-1", external_locator: null, last_verified_at: Date.now() })`,
    );
    await first.run("persistConversationRegistry()");

    // New vm context = new module state, same chrome mock = the same browser.
    const second = loadBackground(mock.chrome);
    const resumed = await second.run(
      'resolveConversationTab({ mode: "continue", id: "conv-A", expected_turn_id: "turn-1" })',
    );

    assert.equal(resumed.id, tabA.id);
    assert.equal(mock.tabsById.size, 1, "no replacement tab was created");
  }

  // 4. A and B share the exact same Temporary Chat URL; CONTINUE A must
  //    select A's tab, never B's.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tabA = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    const tabB = await run('resolveConversationTab({ mode: "fresh", id: "conv-B" })');
    assert.equal(tabA.url, tabB.url);

    await run('conversationRegistry.get("conv-A").head_turn_id = "turn-A1"');
    await run('conversationRegistry.get("conv-B").head_turn_id = "turn-B1"');

    const continued = await run(
      'resolveConversationTab({ mode: "continue", id: "conv-A", expected_turn_id: "turn-A1" })',
    );
    assert.equal(continued.id, tabA.id);
    assert.notEqual(continued.id, tabB.id);
  }

  // 4b. An incomplete assistant turn becomes the live head and recovery uses
  // that exact external identity on the same tab.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tab = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    const listener = mock.messageListeners[0];
    const response = () => {};
    await listener(
      { type: "conversation_bound", id: "req-1", conversation: { id: "conv-A", mode: "fresh", verified: true, ephemeral: true } },
      { tab: { id: tab.id, windowId: tab.windowId } },
      response,
    );
    await listener(
      { type: "incomplete", id: "req-1", metadata: { initial_turn_id: "turn-X" } },
      { tab: { id: tab.id, windowId: tab.windowId } },
      response,
    );
    const resumed = await run('resolveConversationTab({ mode: "continue", id: "conv-A", expected_turn_id: "turn-X" })');
    assert.equal(resumed.id, tab.id);
    assert.equal(await run('conversationRegistry.get("conv-A").head_turn_id'), "turn-X");
  }

  // 5. A's tab is closed: CONTINUE A returns conversation_unavailable, and
  //    zero replacement tabs are created.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tabA = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    await run('conversationRegistry.get("conv-A").head_turn_id = "turn-A1"');
    await mock.chrome.tabs.remove(tabA.id);
    const before = mock.tabsById.size;

    await assert.rejects(
      run(
        'resolveConversationTab({ mode: "continue", id: "conv-A", expected_turn_id: "turn-A1" })',
      ),
      (err) => err.code === "conversation_unavailable",
    );
    assert.equal(mock.tabsById.size, before);
  }

  // 6. expected_turn_id does not equal registry.head_turn_id: no message is
  //    ever sent to the tab, and handlePrompt reports conversation_unavailable.
  {
    const mock = makeChromeMock();
    let sendMessageCalls = 0;
    mock.chrome.tabs.sendMessage = async () => {
      sendMessageCalls += 1;
      return {};
    };
    const { run } = loadBackground(mock.chrome);
    await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    await run('conversationRegistry.get("conv-A").head_turn_id = "turn-A1"');

    const queued = await run(`(async () => {
      await handlePrompt({
        id: "req-1",
        prompt: "hi",
        conversation: { mode: "continue", id: "conv-A", expected_turn_id: "wrong-turn" },
      });
      return enAttente.slice();
    })()`);

    const errorMsg = queued.find((m) => m.id === "req-1" && m.type === "error");
    assert.ok(errorMsg, "handlePrompt must report an error for the mismatched turn");
    assert.equal(errorMsg.code, "conversation_unavailable");
    assert.equal(sendMessageCalls, 0, "no prompt may ever reach the tab");
  }

  // 7. Archiving A closes only A's tab and removes only A's binding.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tabA = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    const tabB = await run('resolveConversationTab({ mode: "fresh", id: "conv-B" })');

    await run('handleConversationArchive({ conversation_id: "conv-A", id: "archive-1" })');

    assert.equal(mock.tabsById.has(tabA.id), false);
    assert.equal(mock.tabsById.has(tabB.id), true);
    assert.equal(await run('conversationRegistry.has("conv-A")'), false);
    assert.equal(await run('conversationRegistry.has("conv-B")'), true);
  }

  // 7b. A missing binding is an explicit failure: no URL lookup and no other
  // ChatGPT tab may be selected as a substitute.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tabB = await run('resolveConversationTab({ mode: "fresh", id: "conv-B" })');

    const packet = await run(
      'handleConversationArchive({ conversation_id: "conv-A", id: "archive-missing" })',
    );

    assert.equal(packet.ok, false);
    assert.equal(packet.code, "conversation_binding_missing");
    assert.equal(packet.conversation_id, "conv-A");
    assert.equal(mock.tabsById.has(tabB.id), true);
  }

  // 7c. An exact tab that disappeared is not silently upgraded to
  // already_closed, and no other tab is closed.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tabA = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    const tabB = await run('resolveConversationTab({ mode: "fresh", id: "conv-B" })');
    mock.tabsById.delete(tabA.id); // keep the registry entry, omit onRemoved

    const packet = await run(
      'handleConversationArchive({ conversation_id: "conv-A", id: "archive-tab-missing" })',
    );

    assert.equal(packet.ok, false);
    assert.equal(packet.code, "conversation_tab_missing");
    assert.equal(mock.tabsById.has(tabB.id), true);
  }

  // 7d. A registry entry without an exact window is an inconsistency, not a
  // reason to fall back to the active window or to an URL match.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tab = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    await run(`conversationRegistry.set("conv-A", { tab_id: ${tab.id} })`);

    const packet = await run(
      'handleConversationArchive({ conversation_id: "conv-A", id: "archive-inconsistent" })',
    );

    assert.equal(packet.ok, false);
    assert.equal(packet.code, "conversation_registry_inconsistent");
    assert.equal(mock.tabsById.has(tab.id), true);
    assert.equal(mock.tabsById.has(999999), false);
  }

  // 7e. A tabs.remove failure is typed and leaves both the exact target and
  // every unrelated tab alone.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tab = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    const other = await mock.chrome.tabs.create({
      url: "https://chatgpt.com/",
      active: false,
      windowId: tab.windowId,
    });
    mock.chrome.tabs.remove = async (tabId) => {
      throw new Error(`cannot remove tab ${tabId}`);
    };

    const packet = await run(
      'handleConversationArchive({ conversation_id: "conv-A", id: "archive-tab-failure" })',
    );

    assert.equal(packet.ok, false);
    assert.equal(packet.code, "conversation_tab_close_failed");
    assert.equal(packet.retryable, true);
    assert.equal(mock.tabsById.has(tab.id), true);
    assert.equal(mock.tabsById.has(other.id), true);
  }

  // 7f. A windows.remove failure is not swallowed as a successful archive.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tab = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    mock.chrome.windows.remove = async (windowId) => {
      throw new Error(`cannot remove window ${windowId}`);
    };

    const packet = await run(
      'handleConversationArchive({ conversation_id: "conv-A", id: "archive-window-failure" })',
    );

    assert.equal(packet.ok, false);
    assert.equal(packet.code, "conversation_window_close_failed");
    assert.equal(packet.retryable, true);
    assert.equal(mock.tabsById.has(tab.id), true);
    assert.equal(mock.windowsById.has(tab.windowId), true);
  }

  // 7g. already_closed is only returned from a proof left by a prior exact
  // successful close; an unknown conversation remains an error.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tab = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    const first = await run(
      'handleConversationArchive({ conversation_id: "conv-A", id: "archive-first" })',
    );
    const second = await run(
      'handleConversationArchive({ conversation_id: "conv-A", id: "archive-second" })',
    );

    assert.equal(first.ok, true);
    assert.equal(first.close_state, "closed");
    assert.equal(first.tab_id, tab.id);
    assert.equal(second.ok, true);
    assert.equal(second.close_state, "already_closed");
    assert.equal(second.tab_id, tab.id);
    assert.equal(mock.tabsById.has(tab.id), false);
  }

  // 8. A tab navigating off the ChatGPT origin invalidates its binding.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tabA = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    assert.equal(await run('conversationRegistry.has("conv-A")'), true);

    for (const fn of mock.updatedListeners) fn(tabA.id, { url: "https://example.com/" });

    assert.equal(await run('conversationRegistry.has("conv-A")'), false);
  }

  // 9. A delivery error is ambiguous: Chrome does not tell us whether the
  // content script received the prompt before sendMessage failed. Keep the
  // exact submitted FRESH binding and refuse a second submission.
  {
    const mock = makeChromeMock();
    let sendMessageCalls = 0;
    mock.chrome.tabs.sendMessage = async () => {
      sendMessageCalls += 1;
      throw new Error("content script unavailable");
    };
    mock.chrome.scripting.executeScript = async () => {
      throw new Error("injection unavailable");
    };
    const { run } = loadBackground(mock.chrome);
    const fresh = {
      id: "req-1",
      prompt: "hello",
      conversation: { mode: "fresh", id: "conv-A" },
    };

    await run(`handlePrompt(${JSON.stringify(fresh)})`);
    assert.equal(await run('requestStates.get("req-1")'), "failed");
    assert.equal(await run('conversationRegistry.get("conv-A").state'), "submitted");
    assert.equal(await run('conversationRegistry.get("conv-A").bridge_run_id'), "req-1");
    assert.equal(mock.tabsById.size, 1);

    await run(
      `handlePrompt(${JSON.stringify({ ...fresh, id: "req-2" })})`,
    );
    assert.equal(mock.tabsById.size, 1, "retry FRESH must not create a replacement tab");
    assert.equal(sendMessageCalls, 1, "ambiguous delivery must never send a second prompt");
    const errorMsg = await run('enAttente.find((m) => m.id === "req-1" && m.type === "error")');
    assert.equal(errorMsg.code, "bridge_extension_disconnected");
    assert.equal(errorMsg.phase, "submission_confirmation");
    assert.equal(errorMsg.submission_state, "submission_attempted");
  }

  // 9b. A stateless delivery error keeps the exact request-scoped target
  // recoverable and a new request cannot reserve another Temporary Chat.
  {
    const mock = makeChromeMock();
    let sendMessageCalls = 0;
    mock.chrome.tabs.sendMessage = async () => {
      sendMessageCalls += 1;
      throw new Error("content script unavailable");
    };
    const { run } = loadBackground(mock.chrome);
    const target = { kind: "temporary_chat_run", id: "target-ambiguous" };
    const prompt = { id: "req-stateless-1", prompt: "hello", browser_target: target };

    await run(`handlePrompt(${JSON.stringify(prompt)})`);
    assert.equal(await run('browserTargetRegistry.get("target-ambiguous").state'), "recoverable");
    assert.equal(await run('browserTargetRegistry.get("target-ambiguous").bridge_run_id'), "req-stateless-1");
    assert.equal(mock.tabsById.size, 1);

    await run(`handlePrompt(${JSON.stringify({ ...prompt, id: "req-stateless-2" })})`);
    assert.equal(mock.tabsById.size, 1, "recovery must not create a replacement tab");
    assert.equal(sendMessageCalls, 1, "recovery must not submit a second prompt");
  }

  // 10. A content-script pre-submission error closes the exact reserved tab.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tab = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    await run(
      `conversationRegistry.set("conv-A", { tab_id: ${tab.id}, state: "submitted", bridge_run_id: "req-1" })`,
    );
    mock.messageListeners[0](
      {
        type: "error",
        id: "req-1",
        conversation: { id: "conv-A", mode: "fresh" },
        submission_state: "pre_submission",
      },
      { tab: { id: tab.id, windowId: tab.windowId } },
      () => {},
    );
    await Promise.resolve();
    assert.equal(mock.tabsById.has(tab.id), false);
    assert.equal(await run('conversationRegistry.has("conv-A")'), false);
  }

  // 11. A post-submission error preserves the live binding for recovery.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tab = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    await run(
      `conversationRegistry.set("conv-A", { tab_id: ${tab.id}, state: "submitted", bridge_run_id: "req-1" })`,
    );
    mock.messageListeners[0](
      {
        type: "error",
        id: "req-1",
        conversation: { id: "conv-A", mode: "fresh" },
        submission_state: "post_submission",
      },
      { tab: { id: tab.id, windowId: tab.windowId } },
      () => {},
    );
    await Promise.resolve();
    assert.equal(mock.tabsById.has(tab.id), true);
    assert.equal(await run('conversationRegistry.get("conv-A").state'), "submitted");
  }

  // 12. Stateless A, sans onglet initial : une seule target réserve un seul
  // Temporary Chat, et UI preflight -> contrôle -> prompt restent sur ce tab.
  {
    const mock = makeChromeMock();
    const sentToTabs = [];
    mock.chrome.tabs.sendMessage = async (tabId, msg) => {
      sentToTabs.push({ tabId, msg });
      if (msg.type === "ui_state" || msg.type === "ui_control") {
        return { ok: true, state: {}, applied: {} };
      }
      return {};
    };
    const { run } = loadBackground(mock.chrome);
    const target = { kind: "temporary_chat_run", id: "target-A" };
    await run(`handleUiRequest(${JSON.stringify({ type: "ui_state", id: "ui-A", browser_target: target })})`);
    await run(`handleUiRequest(${JSON.stringify({ type: "ui_control", id: "control-A", controls: { web_search: true }, browser_target: target })})`);
    await run(`handlePrompt(${JSON.stringify({ type: "prompt", id: "run-A", prompt: "bonjour", new_chat: true, browser_target: target })})`);

    assert.equal(mock.tabsById.size, 1, "un run stateless ne doit créer qu'un Temporary Chat");
    const tab = [...mock.tabsById.values()][0];
    assert.equal(tab.url, "https://chatgpt.com/?temporary-chat=true");
    assert.equal(tab.active, true);
    assert.equal(mock.windowsById.get(tab.windowId).focused, false);
    assert.deepEqual(
      sentToTabs.map(({ tabId }) => tabId),
      [tab.id, tab.id, tab.id],
      "ui_state, ui_control et prompt doivent partager le tab exact",
    );
    assert.ok(sentToTabs.every(({ msg }) => msg.browser_target?.id === target.id));
    assert.equal(sentToTabs.filter(({ msg }) => msg.type === "prompt").length, 1);

    const listener = mock.messageListeners[0];
    listener(
      { type: "done", id: "run-A", text: "ok", conversation: null, metadata: { output_chars: 2 } },
      { tab: { id: tab.id, windowId: tab.windowId } },
      () => {},
    );
    await new Promise((resolve) => setImmediate(resolve));
    const doneEvent = await run('enAttente.find((message) => message.type === "done" && message.id === "run-A")');
    assert.equal(doneEvent.target_id, target.id);
    assert.equal(doneEvent.tab_id, tab.id, "le submit/fin doit rester sur le tab du prompt");
    assert.equal(mock.tabsById.size, 0, "done doit fermer le Temporary Chat exact");
    assert.equal(await run('browserTargetRegistry.has("target-A")'), false);
  }

  // 12a. A stateless post-submission error keeps the exact target, clears the
  // busy/inflight state, and persists an explicit recoverable binding.
  {
    const mock = makeChromeMock();
    mock.chrome.tabs.sendMessage = async () => ({});
    const { run } = loadBackground(mock.chrome);
    const target = { kind: "temporary_chat_run", id: "target-error" };
    await run(`handlePrompt(${JSON.stringify({
      type: "prompt",
      id: "run-error",
      prompt: "bonjour",
      new_chat: true,
      browser_target: target,
    })})`);
    const tab = [...mock.tabsById.values()][0];
    mock.messageListeners[0](
      {
        type: "error",
        id: "run-error",
        code: "bridge_ui_timeout",
        submission_state: "post_submission",
      },
      { tab: { id: tab.id, windowId: tab.windowId } },
      () => {},
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(mock.tabsById.has(tab.id), true);
    assert.equal(await run('inflight.has("run-error")'), false);
    assert.equal(await run(`busyTabs.has(${tab.id})`), false);
    assert.equal(await run('browserTargetRegistry.get("target-error").state'), "recoverable");
    assert.equal(await run('browserTargetRegistry.get("target-error").recoverable'), true);
    assert.equal(await run('browserTargetRegistry.get("target-error").bridge_run_id'), "run-error");
    assert.equal(mock.sessionStore.bridgeBrowserTargetRegistry["target-error"].tab_id, tab.id);
  }

  // 12b. An incomplete post-submit result has the same retention semantics,
  // including when submission_state exists only in its metadata.
  {
    const mock = makeChromeMock();
    mock.chrome.tabs.sendMessage = async () => ({});
    const { run } = loadBackground(mock.chrome);
    const target = { kind: "temporary_chat_run", id: "target-incomplete" };
    await run(`handlePrompt(${JSON.stringify({
      type: "prompt",
      id: "run-incomplete",
      prompt: "bonjour",
      new_chat: true,
      browser_target: target,
    })})`);
    const tab = [...mock.tabsById.values()][0];
    mock.messageListeners[0](
      {
        type: "incomplete",
        id: "run-incomplete",
        metadata: { submission_state: "post_submission" },
      },
      { tab: { id: tab.id, windowId: tab.windowId } },
      () => {},
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(mock.tabsById.has(tab.id), true);
    assert.equal(await run('browserTargetRegistry.get("target-incomplete").state'), "recoverable");
    assert.equal(await run('browserTargetRegistry.get("target-incomplete").bridge_run_id'), "run-incomplete");
  }

  // 12c. Recovery only resolves an already-preserved binding: a missing
  // binding never reserves a replacement Temporary Chat.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const target = { kind: "temporary_chat_run", id: "target-missing" };
    await assert.rejects(
      run(`resolveRecoverableBrowserTarget(${JSON.stringify(target)}, "run-missing")`),
      (err) => err.code === "recovery_unavailable",
    );
    assert.equal(mock.tabsById.size, 0);
  }

  // 12d. Recovery routes to the exact preserved target/run and rejects an
  // unrelated run without touching either tab.
  {
    const mock = makeChromeMock();
    const calls = [];
    mock.chrome.tabs.sendMessage = async (tabId, msg) => {
      calls.push({ tabId, msg });
      return {
        text: "réponse finale",
        turn_id: "assistant-final",
        metadata: {},
      };
    };
    const { run } = loadBackground(mock.chrome);
    const targetA = { kind: "temporary_chat_run", id: "target-recovery-A" };
    const targetB = { kind: "temporary_chat_run", id: "target-recovery-B" };
    const tabA = await run(`resolveBrowserTarget(${JSON.stringify(targetA)})`);
    const tabB = await run(`resolveBrowserTarget(${JSON.stringify(targetB)})`);
    await run(`browserTargetRegistry.set("${targetA.id}", { target_id: "${targetA.id}", tab_id: ${tabA.id}, state: "recoverable", recoverable: true, bridge_run_id: "run-A" })`);
    await run(`browserTargetRegistry.set("${targetB.id}", { target_id: "${targetB.id}", tab_id: ${tabB.id}, state: "recoverable", recoverable: true, bridge_run_id: "run-B" })`);

    await run(`handleRecoveryCapture({ id: "recovery-A", bridge_run_id: "run-A", browser_target: ${JSON.stringify(targetA)} })`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tabId, tabA.id);
    assert.equal(calls[0].msg.bridge_run_id, "run-A");
    assert.equal(calls[0].msg.browser_target.id, targetA.id);

    await run(`handleRecoveryCapture({ id: "recovery-wrong", bridge_run_id: "run-B", browser_target: ${JSON.stringify(targetA)} })`);
    assert.equal(calls.length, 1, "un run différent ne doit pas atteindre l'onglet");
    assert.equal(mock.tabsById.size, 2);
  }

  // 12e. Explicit release is exact and idempotent: it cannot close another
  // preserved target, and repeating it is harmless.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const targetA = { kind: "temporary_chat_run", id: "target-release-A" };
    const targetB = { kind: "temporary_chat_run", id: "target-release-B" };
    const tabA = await run(`resolveBrowserTarget(${JSON.stringify(targetA)})`);
    const tabB = await run(`resolveBrowserTarget(${JSON.stringify(targetB)})`);
    await run(`browserTargetRegistry.set("${targetA.id}", { target_id: "${targetA.id}", tab_id: ${tabA.id}, state: "recoverable", recoverable: true, bridge_run_id: "run-A" })`);
    await run(`browserTargetRegistry.set("${targetB.id}", { target_id: "${targetB.id}", tab_id: ${tabB.id}, state: "recoverable", recoverable: true, bridge_run_id: "run-B" })`);

    await run(`handleBrowserTargetRelease({ id: "release-wrong", run_id: "run-wrong", browser_target: ${JSON.stringify(targetA)} })`);
    assert.equal(mock.tabsById.has(tabA.id), true, "un autre run ne doit pas libérer cette target");
    await run(`handleBrowserTargetRelease({ id: "release-A", run_id: "run-A", browser_target: ${JSON.stringify(targetA)} })`);
    await run(`handleBrowserTargetRelease({ id: "release-A-retry", run_id: "run-A", browser_target: ${JSON.stringify(targetA)} })`);
    assert.equal(mock.tabsById.has(tabA.id), false);
    assert.equal(mock.tabsById.has(tabB.id), true);
    assert.equal(await run(`browserTargetRegistry.has("${targetA.id}")`), false);
    assert.equal(await run(`browserTargetRegistry.has("${targetB.id}")`), true);
  }

  // 12f. Redémarrage du navigateur / rechargement de l'extension :
  // chrome.storage.session est entièrement perdu. Une target stateless connue
  // avant le redémarrage doit échouer fermé — jamais de nouvel onglet, jamais
  // de repli sur un onglet ChatGPT existant, jamais de resoumission.
  {
    const mock = makeChromeMock();
    const survivor = await mock.chrome.tabs.create({
      url: "https://chatgpt.com/?temporary-chat=true",
      active: true,
    });
    const sent = [];
    mock.chrome.tabs.sendMessage = async (tabId, msg) => {
      sent.push({ tabId, msg });
      return {};
    };
    // storage.session est vide : rien n'a survécu au redémarrage.
    assert.deepEqual(mock.sessionStore, {});
    const { run } = loadBackground(mock.chrome);
    const target = { kind: "temporary_chat_run", id: "target-lost-after-restart" };

    await assert.rejects(
      run(`resolveRecoverableBrowserTarget(${JSON.stringify(target)}, "run-lost")`),
      (err) => typeof err.code === "string" && err.code.length > 0,
      "une target inconnue doit échouer avec un code typé",
    );

    await run(`handleRecoveryCapture({ id: "recovery-lost", bridge_run_id: "run-lost", browser_target: ${JSON.stringify(target)} })`);
    await run(`handleBrowserTargetRelease({ id: "release-lost", run_id: "run-lost", browser_target: ${JSON.stringify(target)} })`);

    assert.equal(mock.tabsById.size, 1, "aucun onglet ne doit être créé ni fermé");
    assert.equal(mock.tabsById.has(survivor.id), true);
    assert.equal(sent.length, 0, "aucun message ne doit atteindre un onglet ChatGPT arbitraire");
    assert.equal(await run(`browserTargetRegistry.has("${target.id}")`), false);
  }

  // 13. Un onglet normal préexistant reste intact : le run stateless ouvre sa
  // propre target et ne lui envoie ni contrôle ni prompt.
  {
    const mock = makeChromeMock();
    const normal = await mock.chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    const sentToTabs = [];
    mock.chrome.tabs.sendMessage = async (tabId, msg) => {
      sentToTabs.push({ tabId, msg });
      return msg.type === "ui_state" || msg.type === "ui_control" ? { ok: true, state: {}, applied: {} } : {};
    };
    const { run } = loadBackground(mock.chrome);
    const target = { kind: "temporary_chat_run", id: "target-B" };
    await run(`handleUiRequest(${JSON.stringify({ type: "ui_control", id: "control-B", controls: { web_search: true }, browser_target: target })})`);
    await run(`handlePrompt(${JSON.stringify({ type: "prompt", id: "run-B", prompt: "bonjour", new_chat: true, browser_target: target })})`);

    assert.equal(mock.tabsById.size, 2);
    const temporary = [...mock.tabsById.values()].find((tab) => tab.id !== normal.id);
    assert.equal(temporary.url, "https://chatgpt.com/?temporary-chat=true");
    assert.ok(sentToTabs.every(({ tabId }) => tabId === temporary.id));
    assert.ok(mock.tabsById.has(normal.id), "l'onglet normal ne doit pas être fermé");
    assert.equal(normal.url, "https://chatgpt.com/");
  }

  // 14. Deux targets stateless sont deux bindings indépendants, même si leurs
  // onglets partagent exactement la même URL.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const targetA = { kind: "temporary_chat_run", id: "target-C-A" };
    const targetB = { kind: "temporary_chat_run", id: "target-C-B" };
    const tabA = await run(`resolveBrowserTarget(${JSON.stringify(targetA)})`);
    const tabB = await run(`resolveBrowserTarget(${JSON.stringify(targetB)})`);
    assert.notEqual(tabA.id, tabB.id);
    assert.equal(await run('browserTargetRegistry.get("target-C-A").tab_id'), tabA.id);
    assert.equal(await run('browserTargetRegistry.get("target-C-B").tab_id'), tabB.id);
  }

  // 15. PRE_SUBMISSION supprime la réservation exacte ; un nouvel id crée une
  // nouvelle target et ne réanime jamais l'ancien onglet.
  {
    const mock = makeChromeMock();
    mock.chrome.tabs.sendMessage = async () => ({});
    const { run } = loadBackground(mock.chrome);
    const targetA = { kind: "temporary_chat_run", id: "target-D-A" };
    await run(`handlePrompt(${JSON.stringify({ type: "prompt", id: "run-D-A", prompt: "bonjour", new_chat: true, browser_target: targetA })})`);
    const tabA = [...mock.tabsById.values()][0];
    mock.messageListeners[0](
      {
        type: "error",
        id: "run-D-A",
        code: "bridge_browser_target_required",
        conversation: null,
        submission_state: "pre_submission",
      },
      { tab: { id: tabA.id, windowId: tabA.windowId } },
      () => {},
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mock.tabsById.has(tabA.id), false);
    assert.equal(await run('browserTargetRegistry.has("target-D-A")'), false);

    const targetB = { kind: "temporary_chat_run", id: "target-D-B" };
    const tabB = await run(`resolveBrowserTarget(${JSON.stringify(targetB)})`);
    assert.notEqual(tabA.id, tabB.id);
    assert.equal(mock.tabsById.size, 1);
  }

  // --- Autonomie de l'onglet d'arrière-plan --------------------------------- //

  // 16. L'onglet exact d'un run lié est protégé du déchargement de Chrome,
  // sans jamais être activé ni focalisé.
  {
    const mock = makeChromeMock();
    mock.chrome.tabs.sendMessage = async () => ({});
    const { run } = loadBackground(mock.chrome);
    const target = { kind: "temporary_chat_run", id: "target-E" };
    await run(
      `handlePrompt(${JSON.stringify({ type: "prompt", id: "run-E", prompt: "bonjour", new_chat: true, browser_target: target })})`,
    );
    const tab = [...mock.tabsById.values()][0];
    assert.equal(tab.autoDiscardable, false, "l'onglet lié ne doit pas être déchargeable");
    assert.equal(
      mock.windowsById.get(tab.windowId).focused,
      false,
      "la fenêtre dédiée ne doit jamais prendre le focus",
    );
    assert.equal(mock.userWindow.focused, true);
  }

  // 17. Ticks d'observation : le ping du serveur réveille exactement l'onglet
  // du run en vol, et lui seul. Aucun autre onglet n'est touché, et le tick ne
  // porte aucun contenu.
  {
    const mock = makeChromeMock();
    const ticks = [];
    mock.chrome.tabs.sendMessage = async (tabId, message) => {
      if (message?.type === "observe_tick") ticks.push({ tabId, message });
      return {};
    };
    const { run } = loadBackground(mock.chrome);
    const target = { kind: "temporary_chat_run", id: "target-F" };
    await run(
      `handlePrompt(${JSON.stringify({ type: "prompt", id: "run-F", prompt: "bonjour", new_chat: true, browser_target: target })})`,
    );
    const bound = [...mock.tabsById.values()][0];
    // Un onglet ChatGPT étranger au run : il ne doit jamais recevoir de tick.
    const other = await mock.chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
    await run("pumpObservationTicks()");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      ticks.map((tick) => tick.tabId),
      [bound.id],
      "seul l'onglet exact du run en vol reçoit un tick",
    );
    assert.notEqual(ticks[0].tabId, other.id);
    assert.deepEqual(
      { ...ticks[0].message },
      { type: "observe_tick", id: "run-F" },
      "le tick ne porte que le type et l'id du run",
    );
  }

  // 18. Onglet déchargé pendant un run : échec typé et fermé. Aucune
  // resoumission, aucun onglet de remplacement, target exacte conservée pour
  // une recovery explicite.
  {
    const mock = makeChromeMock();
    mock.chrome.tabs.sendMessage = async () => ({});
    const { run } = loadBackground(mock.chrome);
    const target = { kind: "temporary_chat_run", id: "target-G" };
    await run(
      `handlePrompt(${JSON.stringify({ type: "prompt", id: "run-G", prompt: "bonjour", new_chat: true, browser_target: target })})`,
    );
    const tab = [...mock.tabsById.values()][0];
    const tabsBefore = mock.tabsById.size;

    tab.discarded = true;
    for (const fn of mock.updatedListeners) fn(tab.id, { discarded: true });
    await new Promise((resolve) => setImmediate(resolve));

    const failure = await run('enAttente.find((m) => m.id === "run-G" && m.type === "error")');
    assert.ok(failure, "un déchargement doit produire un échec typé");
    assert.equal(failure.code, "bridge_extension_disconnected");
    assert.equal(failure.submission_state, "post_submission");
    assert.equal(failure.retryable, false, "un run déchargé n'est jamais rejoué");
    assert.equal(failure.tab_id, tab.id);
    assert.equal(failure.diagnostics.tab_state.discarded, true);
    assert.equal(await run('requestStates.get("run-G")'), "failed");
    assert.equal(await run('inflight.has("run-G")'), false);
    assert.equal(mock.tabsById.size, tabsBefore, "aucun onglet de remplacement");
    // Fin ambiguë : la target exacte est conservée pour une recovery explicite,
    // jamais réutilisée pour une nouvelle réservation sous la même identité.
    assert.equal(await run('browserTargetRegistry.get("target-G").state'), "recoverable");
    await assert.rejects(
      run(`resolveBrowserTarget(${JSON.stringify(target)})`),
      (err) => err.code === "recovery_unavailable",
    );
    assert.equal(mock.tabsById.size, tabsBefore);
  }

  // --- Fenêtre Chrome dédiée ------------------------------------------------ //

  // 19. FRESH crée une fenêtre normale non focalisée dont l'onglet Temporary
  // Chat exact est actif. La fenêtre de l'opérateur garde le focus.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tab = await run('resolveConversationTab({ mode: "fresh", id: "conv-W" })');

    assert.equal(mock.windowCreateCalls.length, 1);
    assert.deepEqual(mock.windowCreateCalls[0], {
      url: "https://chatgpt.com/?temporary-chat=true",
      type: "normal",
      focused: false,
      state: "normal",
    });
    const window = mock.windowsById.get(tab.windowId);
    assert.equal(window.type, "normal");
    assert.equal(window.focused, false);
    assert.equal(window.state, "normal");
    assert.notEqual(window.state, "minimized");
    assert.equal(tab.active, true);
    assert.equal(tab.windowId, window.id);

    const entry = await run('conversationRegistry.get("conv-W")');
    assert.equal(entry.tab_id, tab.id);
    assert.equal(entry.window_id, window.id);
    assert.equal(entry.bridge_owned_window, true);
    // Le binding de fenêtre vit en session uniquement.
    assert.equal(
      mock.sessionStore.bridgeConversationRegistry["conv-W"].bridge_owned_window,
      true,
    );
    assert.equal(mock.localStore.bridgeConversationRegistry, undefined);
  }

  // 20. CONTINUE réutilise exactement la même fenêtre et le même onglet :
  // une seule création de fenêtre pour tout le cycle de vie.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const fresh = await run('resolveConversationTab({ mode: "fresh", id: "conv-K" })');
    await run('conversationRegistry.get("conv-K").head_turn_id = "turn-1"');
    const continued = await run(
      'resolveConversationTab({ mode: "continue", id: "conv-K", expected_turn_id: "turn-1" })',
    );

    assert.equal(continued.id, fresh.id);
    assert.equal(continued.windowId, fresh.windowId);
    assert.equal(mock.windowCreateCalls.length, 1, "CONTINUE ne crée jamais de fenêtre");
    assert.equal(mock.tabsById.size, 1);
  }

  // 21. Deux générations fraîches concurrentes : deux fenêtres dédiées, deux
  // onglets actifs, aucune des deux focalisée, aucun routage croisé.
  {
    const mock = makeChromeMock();
    const sent = [];
    mock.chrome.tabs.sendMessage = async (tabId, msg) => {
      sent.push({ tabId, msg });
      return {};
    };
    const { run } = loadBackground(mock.chrome);
    const targetA = { kind: "temporary_chat_run", id: "target-win-A" };
    const targetB = { kind: "temporary_chat_run", id: "target-win-B" };
    await Promise.all([
      run(`handlePrompt(${JSON.stringify({ type: "prompt", id: "run-win-A", prompt: "a", new_chat: true, browser_target: targetA })})`),
      run(`handlePrompt(${JSON.stringify({ type: "prompt", id: "run-win-B", prompt: "b", new_chat: true, browser_target: targetB })})`),
    ]);

    const bindingA = await run('browserTargetRegistry.get("target-win-A")');
    const bindingB = await run('browserTargetRegistry.get("target-win-B")');
    assert.notEqual(bindingA.window_id, bindingB.window_id);
    assert.notEqual(bindingA.tab_id, bindingB.tab_id);
    for (const binding of [bindingA, bindingB]) {
      assert.equal(binding.bridge_owned_window, true);
      assert.equal(mock.tabsById.get(binding.tab_id).active, true);
      assert.equal(mock.windowsById.get(binding.window_id).focused, false);
      assert.equal(mock.windowsById.get(binding.window_id).state, "normal");
    }
    assert.equal(mock.userWindow.focused, true, "aucun run ne vole le focus");
    const prompts = sent.filter(({ msg }) => msg.type === "prompt");
    assert.equal(prompts.length, 2, "chaque prompt est soumis exactement une fois");
    assert.equal(prompts.find(({ msg }) => msg.id === "run-win-A").tabId, bindingA.tab_id);
    assert.equal(prompts.find(({ msg }) => msg.id === "run-win-B").tabId, bindingB.tab_id);
  }

  // 22. Archive : seule la fenêtre dédiée exacte disparaît. Une autre fenêtre
  // dédiée et la fenêtre de l'opérateur restent intactes.
  {
    const mock = makeChromeMock();
    const userTab = await mock.chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    const { run } = loadBackground(mock.chrome);
    const tabA = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    const tabB = await run('resolveConversationTab({ mode: "fresh", id: "conv-B" })');

    await run('handleConversationArchive({ conversation_id: "conv-A", id: "archive-1" })');

    assert.equal(mock.windowsById.has(tabA.windowId), false, "la fenêtre dédiée exacte est fermée");
    assert.equal(mock.tabsById.has(tabA.id), false);
    assert.equal(mock.windowsById.has(tabB.windowId), true);
    assert.equal(mock.tabsById.has(tabB.id), true);
    assert.equal(mock.windowsById.has(mock.userWindow.id), true, "la fenêtre utilisateur survit");
    assert.equal(mock.tabsById.has(userTab.id), true);
    assert.equal(await run('conversationRegistry.has("conv-A")'), false);
    assert.equal(await run('conversationRegistry.has("conv-B")'), true);
  }

  // 22b. Sécurité : si l'opérateur a ajouté ses propres onglets dans la fenêtre
  // dédiée, on ne ferme que l'onglet exact du bridge, jamais la fenêtre.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tab = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    const operatorTab = await mock.chrome.tabs.create({
      url: "https://example.com/",
      active: false,
      windowId: tab.windowId,
    });

    await run('handleConversationArchive({ conversation_id: "conv-A", id: "archive-1" })');

    assert.equal(mock.tabsById.has(tab.id), false, "l'onglet exact du bridge est fermé");
    assert.equal(mock.windowsById.has(tab.windowId), true, "la fenêtre n'est pas fermée");
    assert.equal(mock.tabsById.has(operatorTab.id), true, "l'onglet de l'opérateur survit");
  }

  // 22c. Propriété non prouvable (l'onglet a changé de fenêtre) : on ne ferme
  // jamais la fenêtre enregistrée.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tab = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    const dedicatedWindowId = tab.windowId;
    // L'onglet a été déplacé dans la fenêtre de l'opérateur.
    mock.tabsById.get(tab.id).windowId = mock.userWindow.id;

    await run('handleConversationArchive({ conversation_id: "conv-A", id: "archive-1" })');

    assert.equal(mock.tabsById.has(tab.id), false);
    assert.equal(
      mock.windowsById.has(dedicatedWindowId),
      true,
      "une propriété non prouvée ne ferme jamais une fenêtre",
    );
    assert.equal(mock.windowsById.has(mock.userWindow.id), true);
  }

  // 23. Target stateless : retenue -> conservée, libération finale -> fenêtre
  // dédiée exacte fermée, jamais remplacée, jamais focalisée.
  {
    const mock = makeChromeMock();
    mock.chrome.tabs.sendMessage = async () => ({});
    const { run } = loadBackground(mock.chrome);
    const target = { kind: "temporary_chat_run", id: "target-retain" };
    await run(`handlePrompt(${JSON.stringify({ type: "prompt", id: "run-retain", prompt: "a", new_chat: true, browser_target: target })})`);
    const binding = await run('browserTargetRegistry.get("target-retain")');

    await run(`handleBrowserTargetRetain({ id: "retain-1", run_id: "run-retain", browser_target: ${JSON.stringify(target)} })`);
    assert.equal(await run('browserTargetRegistry.get("target-retain").state'), "recoverable");
    assert.equal(
      await run('browserTargetRegistry.get("target-retain").bridge_owned_window'),
      true,
      "la retenue conserve la propriété de la fenêtre",
    );
    assert.equal(mock.windowsById.has(binding.window_id), true, "retenue : fenêtre gardée vivante");
    assert.equal(mock.windowCreateCalls.length, 1, "une target retenue n'est jamais remplacée");

    await run(`handleBrowserTargetRelease({ id: "release-1", run_id: "run-retain", browser_target: ${JSON.stringify(target)} })`);
    assert.equal(mock.windowsById.has(binding.window_id), false, "libération : fenêtre fermée");
    assert.equal(mock.tabsById.has(binding.tab_id), false);
    assert.equal(await run('browserTargetRegistry.has("target-retain")'), false);
    assert.equal(mock.windowCreateCalls.length, 1, "aucune fenêtre de remplacement");
    assert.equal(mock.userWindow.focused, true);
  }

  // 24. Fermeture manuelle de la fenêtre dédiée pendant un run : échec typé et
  // fermé, aucun rejeu, aucune fenêtre de remplacement.
  {
    const mock = makeChromeMock();
    mock.chrome.tabs.sendMessage = async () => ({});
    const { run } = loadBackground(mock.chrome);
    const target = { kind: "temporary_chat_run", id: "target-closed" };
    await run(`handlePrompt(${JSON.stringify({ type: "prompt", id: "run-closed", prompt: "a", new_chat: true, browser_target: target })})`);
    const binding = await run('browserTargetRegistry.get("target-closed")');

    // L'opérateur ferme la fenêtre dédiée à la main.
    await mock.chrome.windows.remove(binding.window_id);
    await new Promise((resolve) => setImmediate(resolve));

    const failure = await run('enAttente.find((m) => m.id === "run-closed" && m.type === "error")');
    assert.ok(failure, "une fermeture manuelle doit produire un échec typé");
    assert.equal(failure.code, "bridge_extension_disconnected");
    assert.equal(failure.submission_state, "post_submission");
    assert.equal(failure.retryable, false);
    assert.equal(await run('requestStates.get("run-closed")'), "failed");
    assert.equal(await run('inflight.has("run-closed")'), false);
    assert.equal(await run('browserTargetRegistry.has("target-closed")'), false);
    assert.equal(mock.windowCreateCalls.length, 1, "aucune fenêtre de remplacement");
    assert.equal(mock.tabsById.size, 0);
  }

  // 25. Redémarrage du service worker : le binding de session porte le même
  // onglet ET la même fenêtre ; CONTINUE ne crée pas de seconde fenêtre.
  {
    const mock = makeChromeMock();
    const first = loadBackground(mock.chrome);
    const tabA = await first.run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    await first.run('conversationRegistry.get("conv-A").head_turn_id = "turn-1"');
    await first.run("persistConversationRegistry()");

    const second = loadBackground(mock.chrome);
    const resumed = await second.run(
      'resolveConversationTab({ mode: "continue", id: "conv-A", expected_turn_id: "turn-1" })',
    );

    assert.equal(resumed.id, tabA.id);
    assert.equal(resumed.windowId, tabA.windowId);
    assert.equal(await second.run('conversationRegistry.get("conv-A").window_id'), tabA.windowId);
    assert.equal(await second.run('conversationRegistry.get("conv-A").bridge_owned_window'), true);
    assert.equal(mock.windowCreateCalls.length, 1, "un redémarrage ne crée pas de seconde fenêtre");
  }

  // 26. Diagnostics de cycle de vie : les champs fenêtre/onglet sont présents,
  // et un `tab.frozen` absent vaut `null` sans jamais faire échouer la lecture.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const tab = await run('resolveConversationTab({ mode: "fresh", id: "conv-A" })');
    const state = await run(`boundTabState(${tab.id})`);

    assert.equal(state.exists, true);
    assert.equal(state.tab_id, tab.id);
    assert.equal(state.active, true);
    assert.equal(state.frozen, null, "un tab.frozen absent vaut null");
    assert.equal(state.discarded, null);
    assert.equal(state.window_id, tab.windowId);
    assert.equal(state.window_focused, false);
    assert.equal(state.window_state, "normal");
    assert.equal(state.window_type, "normal");

    mock.tabsById.get(tab.id).frozen = false;
    assert.equal((await run(`boundTabState(${tab.id})`)).frozen, false);

    const gone = await run("boundTabState(999999)");
    assert.equal(gone.exists, false);
  }

  // 27. UI diagnostics prefer an inflight ChatGPT tab and expose only the allow-listed snapshot.
  {
    const mock = makeChromeMock();
    mock.localStore.wsToken = "STORED_WS_TOKEN_SECRET";
    const { run } = loadBackground(mock.chrome);
    const activeTab = await mock.chrome.tabs.create({
      url: "https://chatgpt.com/c/active",
      active: true,
    });
    const inflightTab = await mock.chrome.tabs.create({
      url: "https://chatgpt.com/?temporary-chat=true",
      active: false,
    });
    await run(`inflight.set("run-diagnostic", ${inflightTab.id})`);
    const beforeActive = mock.tabsById.get(activeTab.id).active;
    const beforeInflight = mock.tabsById.get(inflightTab.id).active;
    let contentMessage = null;
    mock.chrome.tabs.sendMessage = async (tabId, message) => {
      contentMessage = { tabId, message };
      return {
        ok: true,
        content_script_version: "39",
        surface: {
          origin_ok: true,
          pathname: "/",
          temporary_query: true,
          temporary_status: "ok",
          visibility_state: "hidden",
          has_focus: false,
        },
        composer: {
          status: "degraded",
          strategy: "structural_fallback",
          selector: "[contenteditable='true'][role='textbox']",
          visible_candidates: 1,
          known_selector_candidates: 0,
          structural_candidates: 1,
          tag: "DIV",
          role: "textbox",
          contenteditable: true,
          data_composer_markdown: false,
          form_found: true,
        },
        send: {
          status: "degraded",
          strategy: "structural_fallback",
          selector: "button[type='submit']",
          visible_candidates: 1,
          type: "submit",
          disabled: false,
          aria_disabled: false,
          same_form_as_composer: true,
        },
        prompt: "TOP_SECRET_PROMPT_123",
        response: "PRIVATE_RESPONSE",
        wsToken: "FORBIDDEN_TOKEN",
        Authorization: "Bearer SECRET",
      };
    };

    const diagnosticPromise = new Promise((resolve) => {
      const handled = mock.messageListeners.some((listener) =>
        listener({ type: "diagnose_ui" }, {}, resolve),
      );
      assert.equal(handled, true);
    });
    const diagnostics = await diagnosticPromise;
    assert.equal(contentMessage.tabId, inflightTab.id);
    assert.equal(contentMessage.message.type, "dom_health");
    assert.equal(diagnostics.tab_id, inflightTab.id);
    assert.equal(diagnostics.diagnostic_target.source, "inflight");
    assert.equal(diagnostics.diagnostic_target.bridge_owned, true);
    assert.equal(diagnostics.composer.status, "degraded");
    assert.equal(diagnostics.send.status, "degraded");
    assert.equal(diagnostics.websocket_state, "disconnected");
    assert.equal(mock.tabsById.get(activeTab.id).active, beforeActive);
    assert.equal(mock.tabsById.get(inflightTab.id).active, beforeInflight);
    const json = JSON.stringify(diagnostics);
    for (const forbidden of [
      "STORED_WS_TOKEN_SECRET",
      "TOP_SECRET_PROMPT_123",
      "PRIVATE_RESPONSE",
      "FORBIDDEN_TOKEN",
      "Bearer SECRET",
      "wsToken",
      "Authorization",
      "prompt",
      "innerText",
      "innerHTML",
      "textContent",
    ]) {
      assert.equal(json.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
    }
  }

  // A live exact browser_target outranks every URL/active-tab candidate.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const active = await mock.chrome.tabs.create({ url: "https://chatgpt.com/c/user", active: true });
    const targetTab = await mock.chrome.tabs.create({ url: "https://chatgpt.com/?temporary-chat=true", active: false });
    const otherTemporary = await mock.chrome.tabs.create({ url: "https://chatgpt.com/?temporary-chat=true", active: false });
    await run("browserTargetRegistryReady");
    await run(`browserTargetRegistry.set("run-exact", { target_id: "run-exact", tab_id: ${targetTab.id}, bridge_owned_window: true, state: "recoverable" })`);
    let diagnosedTab = null;
    mock.chrome.tabs.sendMessage = async (tabId) => {
      diagnosedTab = tabId;
      return { ok: true, surface: {}, composer: { status: "ok" }, send: { status: "not_rendered_idle" } };
    };
    const result = await run("handleUiDiagnostic()");
    assert.equal(diagnosedTab, targetTab.id);
    assert.equal(result.diagnostic_target.source, "browser_target");
    assert.equal(result.diagnostic_target.bridge_owned, true);
    assert.notEqual(diagnosedTab, active.id);
    assert.notEqual(diagnosedTab, otherTemporary.id);
  }

  // 27bis. Échelle de priorité du diagnostic, vérifiée de bout en bout : run
  // inflight exact -> browser target exact -> conversation retenue -> onglet
  // d'une fenêtre du bridge -> onglet ChatGPT quelconque, en dernier recours.
  // « Plusieurs tabs ChatGPT ouverts, un run inflight utilise tab X » : le
  // popup doit diagnostiquer X, jamais le tab actif quelconque.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    // L'onglet visible de l'opérateur : actif, mais étranger au bridge.
    const generic = await mock.chrome.tabs.create({
      url: "https://chatgpt.com/c/user-visible",
      active: true,
    });
    const inflightWindow = await mock.chrome.windows.create({
      url: "https://chatgpt.com/?temporary-chat=true",
      type: "normal",
      focused: false,
      state: "normal",
    });
    const inflightTab = inflightWindow.tabs[0];
    const conversationWindow = await mock.chrome.windows.create({
      url: "https://chatgpt.com/?temporary-chat=true",
      type: "normal",
      focused: false,
      state: "normal",
    });
    const conversationTab = conversationWindow.tabs[0];
    // Fenêtre du bridge dont la cible enregistrée a disparu : seul le repli
    // `bridge_owned_tab` peut encore la retrouver, jamais l'onglet actif.
    const recoveryWindow = await mock.chrome.windows.create({
      url: "https://chatgpt.com/?temporary-chat=true",
      type: "normal",
      focused: false,
      state: "normal",
    });
    const ownedTab = recoveryWindow.tabs[0];

    await run("browserTargetRegistryReady");
    await run("conversationRegistryReady");
    await run(`inflight.set("run-inflight", ${inflightTab.id})`);
    await run(
      `browserTargetRegistry.set("run-inflight", { target_id: "run-inflight", tab_id: ${inflightTab.id}, bridge_owned_window: true, window_id: ${inflightWindow.id}, state: "live" })`,
    );
    await run(
      `browserTargetRegistry.set("run-recovery", { target_id: "run-recovery", tab_id: 987654321, bridge_owned_window: true, window_id: ${recoveryWindow.id}, state: "recoverable" })`,
    );
    await run(
      `conversationRegistry.set("conv-A", { id: "conv-A", tab_id: ${conversationTab.id}, bridge_owned_window: true, window_id: ${conversationWindow.id} })`,
    );

    // Le contenu réel d'un run : les trois secrets du contrat de diagnostic
    // sont injectés à chaque niveau pour prouver qu'aucun ne traverse.
    const runStatePayload = () => ({
      active: true,
      phase: "generation",
      state: "active",
      mode: "watched_turn",
      confidence: "high",
      signal: "streaming",
      output_chars: 42,
      stable_for_ms: 85000,
      stable_threshold_ms: 300000,
      stable_observations: 12,
      signals: { actions: false, streaming: true, reasoning: false, stop: false },
      serialization: {
        root_found: true,
        serializer: "chatgpt-dom-v3",
        last_serialize: "ok",
        ms: 3,
      },
      observation: {
        last_wake: { mutation: 4, observe_tick: 2, timer: 1 },
        ms_since_observation: 120,
        ms_since_dom_mutation: 250,
      },
      prompt: "PROMPT_SECRET_123",
      response_text: "RESPONSE_SECRET_456",
      innerText: "RESPONSE_SECRET_456",
      textContent: "RESPONSE_SECRET_456",
      wsToken: "Bearer SECRET_789",
      Authorization: "Bearer SECRET_789",
      cookie: "PROMPT_SECRET_123",
      localStorage: "RESPONSE_SECRET_456",
    });
    let sent = [];
    mock.chrome.tabs.sendMessage = async (tabId, message) => {
      sent.push({ tabId, type: message.type });
      if (message.type === "run_state") return runStatePayload();
      // Réponse de diagnostic empoisonnée : les secrets sont injectés à chaque
      // niveau, y compris hors contrat, pour prouver qu'aucun ne traverse la
      // liste blanche du service worker.
      return {
        ok: true,
        content_script_version: "39",
        prompt: "PROMPT_SECRET_123",
        response: "RESPONSE_SECRET_456",
        response_text: "RESPONSE_SECRET_456",
        innerText: "RESPONSE_SECRET_456",
        textContent: "RESPONSE_SECRET_456",
        innerHTML: "RESPONSE_SECRET_456",
        Authorization: "Bearer SECRET_789",
        wsToken: "Bearer SECRET_789",
        cookie: "PROMPT_SECRET_123",
        surface: { title: "RESPONSE_SECRET_456" },
        composer: { status: "ok", text: "PROMPT_SECRET_123" },
        send: { status: "not_rendered_idle", label: "RESPONSE_SECRET_456" },
        response_locator: { element: "RESPONSE_SECRET_456" },
        run: runStatePayload(),
      };
    };
    const diagnosticFor = async () => {
      sent = [];
      const result = await run("handleUiDiagnostic()");
      return { result, calls: sent };
    };
    const runStateFor = async () => {
      sent = [];
      const result = await run("handleRunState()");
      return { result, calls: sent };
    };
    const secrets = ["PROMPT_SECRET_123", "RESPONSE_SECRET_456", "SECRET_789"];
    const assertClean = (label, value) => {
      const json = JSON.stringify(value);
      for (const secret of secrets) {
        assert.equal(json.includes(secret), false, `${label}: ${secret}`);
      }
    };

    // 1. Run inflight exact : il gagne sur l'onglet actif et sur tout le reste.
    const first = await diagnosticFor();
    assert.equal(first.result.diagnostic_target.source, "inflight");
    assertClean("inflight", first.result);
    assert.equal(first.result.diagnostic_target.bridge_owned, true);
    assert.equal(first.result.tab_id, inflightTab.id);
    assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0].tabId, inflightTab.id);
    assert.equal(first.calls[0].type, "dom_health");
    assert.notEqual(first.calls[0].tabId, generic.id);
    assert.equal(mock.tabsById.get(generic.id).active, true);

    // Le popup qui rafraîchit l'état vivant interroge exactement le même tab.
    const liveRun = await runStateFor();
    assert.equal(liveRun.calls[0].type, "run_state");
    assert.equal(liveRun.calls[0].tabId, inflightTab.id);
    assert.equal(liveRun.result.diagnostic_target.source, "inflight");
    assert.equal(liveRun.result.run.state, "active");
    assert.equal(liveRun.result.run.signal, "streaming");
    assert.equal(liveRun.result.run.stable_threshold_ms, 300000);
    assert.equal(liveRun.result.run.observation.last_wake.observe_tick, 2);
    assert.equal(liveRun.result.run.serialization.serializer, "chatgpt-dom-v3");
    assertClean("run_state", liveRun.result);
    assert.equal(liveRun.result.run.active, true);
    assert.equal(liveRun.result.run.state, "active");
    for (const forbidden of ["prompt", "response_text", "innerText", "textContent", "wsToken", "Authorization"]) {
      assert.equal(Object.hasOwn(liveRun.result.run, forbidden), false, forbidden);
    }

    // 2. Plus de run inflight : la browser target exacte prend le relais.
    await run('inflight.delete("run-inflight")');
    const second = await diagnosticFor();
    assert.equal(second.result.diagnostic_target.source, "browser_target");
    assertClean("browser_target", second.result);
    assert.equal(second.result.tab_id, inflightTab.id);

    // 3. La cible a disparu : la conversation retenue reste prioritaire sur
    //    l'onglet actif de l'opérateur.
    await mock.chrome.tabs.remove(inflightTab.id);
    const third = await diagnosticFor();
    assert.equal(third.result.diagnostic_target.source, "bridge_conversation");
    assertClean("bridge_conversation", third.result);
    assert.equal(third.result.tab_id, conversationTab.id);
    assert.notEqual(third.result.tab_id, generic.id);

    // 4. Plus aucune cible exacte : l'onglet de la fenêtre du bridge est
    //    retrouvé par sa fenêtre, jamais par l'onglet actif.
    await mock.chrome.tabs.remove(conversationTab.id);
    const fourth = await diagnosticFor();
    assert.equal(fourth.result.diagnostic_target.source, "bridge_owned_tab");
    assertClean("bridge_owned_tab", fourth.result);
    assert.equal(fourth.result.diagnostic_target.bridge_owned, true);
    assert.equal(fourth.result.tab_id, ownedTab.id);
    assert.notEqual(fourth.result.tab_id, generic.id);

    // 5. Dernier recours seulement : l'onglet ChatGPT de l'opérateur, annoncé
    //    comme non possédé pour que le popup n'affiche aucun faux état de run.
    await mock.chrome.windows.remove(recoveryWindow.id);
    const fifth = await diagnosticFor();
    assert.equal(fifth.result.diagnostic_target.source, "generic_chatgpt_tab");
    assertClean("generic_chatgpt_tab", fifth.result);
    assert.equal(fifth.result.diagnostic_target.bridge_owned, false);
    assert.equal(fifth.result.tab_id, generic.id);
    assertClean("generic tab", fifth.result);
  }

  // Without a bridge binding or Temporary Chat, fallback is explicit.
  {
    const mock = makeChromeMock();
    const { run } = loadBackground(mock.chrome);
    const generic = await mock.chrome.tabs.create({ url: "https://chatgpt.com/c/generic", active: true });
    mock.chrome.tabs.sendMessage = async (tabId) => {
      assert.equal(tabId, generic.id);
      return { ok: true, surface: { temporary_status: "invalid" }, composer: { status: "ok" }, send: { status: "not_rendered_idle" } };
    };
    const result = await run("handleUiDiagnostic()");
    assert.equal(result.diagnostic_target.source, "generic_chatgpt_tab");
    assert.equal(result.diagnostic_target.bridge_owned, false);
    assert.equal(result.surface.temporary_status, "invalid");
    assert.equal(result.ok, true);
  }

  // 28. Contrat « pas de vol de focus » sur la source elle-même.
  {
    assert.doesNotMatch(BACKGROUND_SOURCE, /focused:\s*true/);
    assert.doesNotMatch(BACKGROUND_SOURCE, /chrome\.windows\.update/);
    assert.doesNotMatch(BACKGROUND_SOURCE, /active:\s*true/);
    assert.doesNotMatch(BACKGROUND_SOURCE, /window\.focus\(/);
    assert.doesNotMatch(BACKGROUND_SOURCE, /state:\s*"minimized"/);
    // chrome.tabs.update ne sert qu'à autoDiscardable.
    const updates = BACKGROUND_SOURCE.match(/chrome\.tabs\.update\([^)]*\)/g) || [];
    assert.deepEqual(updates, ["chrome.tabs.update(tabId, { autoDiscardable })"]);

    const closeStart = BACKGROUND_SOURCE.indexOf("async function closeBoundTarget");
    const closeEnd = BACKGROUND_SOURCE.indexOf("function isBrowserTarget", closeStart);
    const closeSource = BACKGROUND_SOURCE.slice(closeStart, closeEnd);
    assert.doesNotMatch(closeSource, /tabs\.query/);
    assert.doesNotMatch(closeSource, /url/);
  }

  console.log("background conversation routing contract: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
