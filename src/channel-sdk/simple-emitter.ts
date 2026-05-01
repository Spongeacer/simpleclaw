/**
 * SimpleClaw — Platform-agnostic event emitter
 * Replaces Node.js EventEmitter for Layer 4 (channel-sdk) browser compatibility.
 */

export class SimpleEmitter {
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, fn: (...args: unknown[]) => void): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(fn);
  }

  off(event: string, fn: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(fn);
  }

  emit(event: string, ...args: unknown[]): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      try { h(...args); } catch { /* handler errors are intentionally ignored */ }
    }
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }
}
