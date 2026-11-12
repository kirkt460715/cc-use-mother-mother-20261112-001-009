import { clone, integer, Invalid } from '../scenarios/values.js';

export const PRIORITY = {
  discharge: 0,
  capacity: 1,
  arrival: 2,
  timeout: 3,
  horizon: 4
};

export function compareEvents(left, right) {
  return left.time - right.time || PRIORITY[left.kind] - PRIORITY[right.kind] || left.sequence - right.sequence;
}

export class EventHeap {
  constructor(events = []) {
    this.items = [];
    this.sequence = 0;
    for (const event of events) {
      this.push(event.time, event.kind, event.payload);
    }
  }

  push(time, kind, payload = {}) {
    integer(time, 'event time', 0, 1000000);
    if (!Object.hasOwn(PRIORITY, kind)) {
      throw new Invalid('unknown event kind');
    }
    const event = {
      time,
      kind,
      payload: clone(payload),
      sequence: this.sequence++
    };
    this.items.push(event);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareEvents(this.items[parent], this.items[index]) <= 0) {
        break;
      }
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
    return event;
  }

  peek() {
    return this.items.length ? clone(this.items[0]) : null;
  }

  pop() {
    if (!this.items.length) {
      return null;
    }
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      this.items[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.items.length && compareEvents(this.items[left], this.items[smallest]) < 0) {
          smallest = left;
        }
        if (right < this.items.length && compareEvents(this.items[right], this.items[smallest]) < 0) {
          smallest = right;
        }
        if (smallest === index) {
          break;
        }
        [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
        index = smallest;
      }
    }
    return clone(first);
  }

  takeTime(time) {
    const output = [];
    while (this.peek() && this.peek().time === time) {
      output.push(this.pop());
    }
    return output;
  }

  export() {
    return {
      sequence: this.sequence,
      items: clone(this.items)
    };
  }

  static restore(document) {
    integer(document.sequence, 'heap sequence');
    const heap = new EventHeap();
    heap.sequence = document.sequence;
    heap.items = clone(document.items);
    const sequences = new Set();
    for (let index = 0; index < heap.items.length; index += 1) {
      const event = heap.items[index];
      integer(event.time, 'event time', 0, 1000000);
      integer(event.sequence, 'sequence', 0, heap.sequence - 1);
      if (!Object.hasOwn(PRIORITY, event.kind) || sequences.has(event.sequence)) {
        throw new Invalid('invalid restored event identity');
      }
      sequences.add(event.sequence);
      if (index > 0 && compareEvents(heap.items[Math.floor((index - 1) / 2)], event) > 0) {
        throw new Invalid('restored heap order invalid');
      }
    }
    return heap;
  }
}
