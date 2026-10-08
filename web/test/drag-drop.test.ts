import { describe, expect, test } from 'vitest';
import { readDropIntent } from '$features/drawer/periods/dragDrop.js';

describe('dragDrop', () => {
  describe('readDropIntent', () => {
    test('period data means reorder', () => {
      const event = {
        dataTransfer: {
          getData: (type: string) => (type === 'application/x-lpm-period' ? 'Q1' : ''),
        },
      } as unknown as DragEvent;
      expect(readDropIntent(event)).toEqual({ kind: 'reorder', periodId: 'Q1' });
    });

    test('period data wins over issue data', () => {
      const event = {
        dataTransfer: {
          getData: (type: string) => {
            if (type === 'application/x-lpm-period') return 'Q1';
            if (type === 'application/x-lpm-issue') return 'LP-1';
            return '';
          },
        },
      } as unknown as DragEvent;
      expect(readDropIntent(event)).toEqual({ kind: 'reorder', periodId: 'Q1' });
    });

    test('issue data without period means schedule', () => {
      const event = {
        dataTransfer: {
          getData: (type: string) => (type === 'application/x-lpm-issue' ? 'LP-1' : ''),
        },
      } as unknown as DragEvent;
      expect(readDropIntent(event)).toEqual({ kind: 'schedule', issueId: 'LP-1' });
    });

    test('no transfer data means none', () => {
      const event = {
        dataTransfer: { getData: () => '' },
      } as unknown as DragEvent;
      expect(readDropIntent(event)).toEqual({ kind: 'none' });
    });

    test('null dataTransfer means none', () => {
      const event = { dataTransfer: null } as unknown as DragEvent;
      expect(readDropIntent(event)).toEqual({ kind: 'none' });
    });
  });
});
