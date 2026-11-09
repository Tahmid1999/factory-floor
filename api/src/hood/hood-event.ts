export type HoodEvent = {
  t: number;
  kind: 'batch' | 'apply' | 'held' | 'released' | 'gate' | 'resync' | 'rework' | 'clear' | 'sweep' | 'limit' | 'purge';
  proc: 'api' | 'worker';
  text: string;
};
