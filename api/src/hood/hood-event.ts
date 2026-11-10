export type HoodEvent = {
  t: number;
  kind: 'batch' | 'apply' | 'held' | 'released' | 'gate' | 'resync' | 'rework' | 'clear' | 'sweep' | 'limit' | 'purge' | 'stock' | 'stress';
  proc: 'api' | 'worker';
  text: string;
  // Set by Rabbit on the wire only; never stored or shown.
  pid?: string;
};
