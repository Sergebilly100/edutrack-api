import EventEmitter2 from 'eventemitter2';
import type {
  ConstructorOptions,
  EventEmitter2 as EventEmitter2Type,
} from 'eventemitter2';

import type { EmittableEventMap, EventMap } from './events.types.js';

type EventName = keyof EventMap;
type EmittableEventName = keyof EmittableEventMap;
type EventHandler<K extends EventName> = (payload: EventMap[K]) => void;
const DEFAULT_MAX_LISTENERS = 50;
type EventEmitter2Ctor = new (options?: ConstructorOptions) => EventEmitter2Type;
const EventEmitter2Class = EventEmitter2 as unknown as EventEmitter2Ctor;

class EventBus {
  private readonly emitter: EventEmitter2Type;

  constructor() {
    this.emitter = new EventEmitter2Class({
      wildcard: true,
      delimiter: '.',
      maxListeners:
        Number(process.env.EVENT_BUS_MAX_LISTENERS) || DEFAULT_MAX_LISTENERS,
    });
  }

  emit<K extends EmittableEventName>(
    event: K,
    payload: EmittableEventMap[K]
  ): void {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(
        '[EventBus]',
        event,
        '— tenantId:',
        (payload as { tenantId: string }).tenantId
      );
    }

    this.emitter.emit(event as string, payload);
  }

  on<K extends EventName>(event: K, handler: EventHandler<K>): void {
    this.emitter.on(event as string, handler as (payload: unknown) => void);
  }

  off<K extends EventName>(event: K, handler: EventHandler<K>): void {
    this.emitter.off(event as string, handler as (payload: unknown) => void);
  }
}

export const eventBus = new EventBus();

export const emit = <K extends EmittableEventName>(
  event: K,
  payload: EmittableEventMap[K]
): void => {
  eventBus.emit(event, payload);
};

export const on = <K extends EventName>(
  event: K,
  handler: (payload: EventMap[K]) => void
): void => {
  eventBus.on(event, handler);
};

export const off = <K extends EventName>(
  event: K,
  handler: (payload: EventMap[K]) => void
): void => {
  eventBus.off(event, handler);
};
