// The few Chrome extension APIs the extension uses, typed here instead of adding a types package for them.
declare namespace chrome.runtime {
  interface Port {
    name: string;
    postMessage(message: unknown): void;
    disconnect(): void;
    onMessage: { addListener(callback: (message: any, port: Port) => void): void };
    onDisconnect: { addListener(callback: (port: Port) => void): void };
  }
  function connect(info: { name: string }): Port;
  const onConnect: { addListener(callback: (port: Port) => void): void };
  function sendMessage(message: unknown): Promise<any>;
  /** Returning true keeps `respond` usable after the listener returns, for an answer that comes asynchronously. */
  const onMessage: { addListener(callback: (message: any, sender: unknown, respond: (answer: unknown) => void) => boolean | void): void };
}
declare namespace chrome.storage {
  interface StorageArea {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  }
  /** Kept in memory until the browser closes; shared by every tab. */
  const session: StorageArea;
}
