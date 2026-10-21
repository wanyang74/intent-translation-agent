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
}
