import { TaskControlService } from './task-control.service';

describe('TaskControlService', () => {
  it('pause blocks until resume', async () => {
    const ctl = new TaskControlService();
    ctl.beginRun('c1');
    ctl.pause('c1');

    let released = false;
    const waiting = ctl.waitIfPaused('c1').then(() => {
      released = true;
    });

    await Promise.resolve();
    expect(released).toBe(false);

    ctl.resume('c1');
    await waiting;
    expect(released).toBe(true);
  });

  it('queues and drains guidance', () => {
    const ctl = new TaskControlService();
    ctl.queueGuidance('c1', 'use bank tab');
    ctl.queueGuidance('c1', 'then ask human');
    expect(ctl.drainGuidance('c1')).toBe('use bank tab\nthen ask human');
    expect(ctl.drainGuidance('c1')).toBeNull();
  });
});
