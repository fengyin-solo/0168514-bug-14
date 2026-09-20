// Node 环境下的 localStorage / window 极简 polyfill，用于测试纯逻辑层
type StorageListener = (event: StorageEventLike) => void;

interface StorageEventLike {
  key: string | null;
  newValue: string | null;
  oldValue: string | null;
}

class LocalStorageMock {
  private store: Record<string, string> = {};
  private listeners = new Set<StorageListener>();

  get length(): number {
    return Object.keys(this.store).length;
  }

  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, key)
      ? (this.store[key] ?? null)
      : null;
  }

  setItem(key: string, value: string): void {
    // 浏览器中 storage 事件不在写入窗口触发，这里也不自动触发；
    // 由测试显式调用 emitStorage 模拟“其它窗口”写入。
    this.store[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }

  key(index: number): string | null {
    return Object.keys(this.store)[index] ?? null;
  }

  addListener(fn: StorageListener): void {
    this.listeners.add(fn);
  }

  removeListener(fn: StorageListener): void {
    this.listeners.delete(fn);
  }

  /** 模拟另一个窗口写入后浏览器派发的 storage 事件 */
  emitStorage(key: string, newValue: string | null, oldValue: string | null = null): void {
    if (newValue !== null) {
      this.store[key] = newValue;
    } else {
      delete this.store[key];
    }
    this.listeners.forEach((fn) => fn({ key, newValue, oldValue }));
  }
}

const localStorageMock = new LocalStorageMock();

const listeners: Record<string, Set<(event?: unknown) => void>> = {
  storage: new Set(),
  beforeunload: new Set(),
  pagehide: new Set(),
};

const visibilityListeners = new Set<() => void>();

const windowMock = {
  localStorage: localStorageMock,
  addEventListener: (type: string, fn: (event?: unknown) => void) => {
    if (type === 'storage') {
      localStorageMock.addListener(fn as StorageListener);
    } else {
      listeners[type]?.add(fn);
    }
  },
  removeEventListener: (type: string, fn: (event?: unknown) => void) => {
    if (type === 'storage') {
      localStorageMock.removeListener(fn as StorageListener);
    } else {
      listeners[type]?.delete(fn);
    }
  },
  dispatchEvent: (type: string): void => {
    listeners[type]?.forEach((fn) => fn(undefined));
  },
};

const documentMock = {
  visibilityState: 'visible' as 'visible' | 'hidden',
  addEventListener: (type: string, fn: () => void) => {
    if (type === 'visibilitychange') {
      visibilityListeners.add(fn);
    }
  },
  setVisibility(state: 'visible' | 'hidden') {
    this.visibilityState = state;
    visibilityListeners.forEach((fn) => fn());
  },
};

Object.assign(globalThis, {
  localStorage: localStorageMock,
  window: windowMock,
  document: documentMock,
  btoa: (input: string) => Buffer.from(input, 'binary').toString('base64'),
  atob: (input: string) => Buffer.from(input, 'base64').toString('binary'),
});

export { localStorageMock, windowMock, documentMock };
