import { SubscriptionProcessor } from './subscription.js';
import { GraphQLRowOperation } from './events.js';

describe('SubscriptionProcessor', () => {
  let processor: SubscriptionProcessor;

  // Helper to create properly formatted events: a timestamp's list of
  // updates, here holding one
  const createEvent = (operation: string, key: unknown, rowData: any) => ({
    data: [{ operation, key, data: rowData }],
  });

  const alice = { id: 1, name: 'Alice', age: 30 };
  const bob = { id: 2, name: 'Bob', age: 25 };
  const charlie = { id: 3, name: 'Charlie', age: 35 };

  describe('with Map-based expected state', () => {
    beforeEach(() => {
      const expectedState = new Map([
        [1, alice],
        [2, bob],
        [3, charlie],
      ]);

      processor = new SubscriptionProcessor(
        expectedState,
        'data', // dataPath
      );
    });

    describe('INSERT operations', () => {
      it('should process INSERT for expected item', () => {
        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 1, alice),
        );

        const stats = processor.getStats();
        expect(stats.totalExpected).toBe(3);
        expect(stats.totalReceived).toBe(1);
        expect(processor.isComplete()).toBe(false);
      });

      it('should track unexpected INSERT', () => {
        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 99, {
            id: 99,
            name: 'Unknown',
            age: 40,
          }),
        );

        const stats = processor.getStats();
        expect(stats.totalExpected).toBe(3);
        expect(stats.totalReceived).toBe(1); // Unexpected items ARE counted in currentState
        expect(processor.isComplete()).toBe(false); // But they prevent completion
      });

      it('should detect state mismatch on wrong data', () => {
        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 1, { ...alice, age: 31 }),
        );

        expect(processor.isComplete()).toBe(false);
        // State doesn't match expected
      });

      it('should throw on duplicate INSERT', () => {
        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 1, alice),
        );

        expect(() => {
          processor.processEvent(
            createEvent(GraphQLRowOperation.Insert, 1, alice),
          );
        }).toThrow('Received duplicate INSERT for item 1');
      });

      it('should throw on INSERT without data', () => {
        expect(() => {
          processor.processEvent(
            createEvent(GraphQLRowOperation.Insert, 1, null),
          );
        }).toThrow('Received INSERT for item 1 without data');
      });

      it('should throw on an update without a key', () => {
        expect(() => {
          processor.processEvent(
            createEvent(GraphQLRowOperation.Insert, undefined, alice),
          );
        }).toThrow('Invalid operation key');
      });

      it('should key a row by its update key, 0 included, not by a column', () => {
        const zero = new SubscriptionProcessor(
          new Map([[0, { code: 'x' }]]),
          'data',
        );

        zero.processEvent(
          createEvent(GraphQLRowOperation.Insert, 0, { code: 'x' }),
        );

        expect(zero.isComplete()).toBe(true);
      });
    });

    describe("a timestamp's updates", () => {
      it('should apply every update in the list, in order', () => {
        processor.processEvent({
          data: [
            {
              operation: GraphQLRowOperation.Insert,
              key: 1,
              data: { ...alice, age: 29 },
            },
            { operation: GraphQLRowOperation.Update, key: 1, data: alice },
            { operation: GraphQLRowOperation.Insert, key: 2, data: bob },
          ],
        });

        expect(processor.getStats().totalReceived).toBe(2);
      });

      it('should accept an empty list, as an empty snapshot is', () => {
        processor.processEvent({ data: [] });

        expect(processor.getStats().totalReceived).toBe(0);
      });
    });

    describe('UPDATE operations', () => {
      it('should replace the row with the UPDATE as a whole', () => {
        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 1, alice),
        );
        processor.processEvent(
          createEvent(GraphQLRowOperation.Update, 1, {
            ...alice,
            name: 'Alice Updated',
          }),
        );
        processor.processEvent(createEvent(GraphQLRowOperation.Insert, 2, bob));
        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 3, charlie),
        );

        // The row is the updated one, not the first
        expect(processor.getStats().totalReceived).toBe(3);
        expect(processor.isComplete()).toBe(false);
      });

      it('should leave the row as it is when the UPDATE has no data', () => {
        for (const [key, row] of [
          [1, alice],
          [2, bob],
          [3, charlie],
        ] as const) {
          processor.processEvent(
            createEvent(GraphQLRowOperation.Insert, key, row),
          );
        }

        processor.processEvent(
          createEvent(GraphQLRowOperation.Update, 1, null),
        );

        expect(processor.getStats().totalReceived).toBe(3);
        expect(processor.isComplete()).toBe(true);
      });

      it('should throw on UPDATE before INSERT', () => {
        expect(() => {
          processor.processEvent(
            createEvent(GraphQLRowOperation.Update, 1, alice),
          );
        }).toThrow('Received UPDATE for non-existent item 1');
      });

      it('should throw on UPDATE with no data before INSERT', () => {
        expect(() => {
          processor.processEvent(
            createEvent(GraphQLRowOperation.Update, 1, null),
          );
        }).toThrow('Received UPDATE for non-existent item 1');
      });
    });

    describe('DELETE operations', () => {
      it('should remove item on DELETE, by its key alone', () => {
        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 1, alice),
        );

        processor.processEvent(
          createEvent(GraphQLRowOperation.Delete, 1, null),
        );

        expect(processor.getStats().totalReceived).toBe(0);
      });

      it('should handle DELETE for non-existent item', () => {
        processor.processEvent(
          createEvent(GraphQLRowOperation.Delete, 99, null),
        );

        const stats = processor.getStats();
        expect(stats.totalReceived).toBe(0);
        expect(processor.isComplete()).toBe(false);
      });
    });

    describe('completion detection', () => {
      it('should detect completion when state matches exactly', () => {
        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 1, alice),
        );
        processor.processEvent(createEvent(GraphQLRowOperation.Insert, 2, bob));

        expect(processor.isComplete()).toBe(false);

        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 3, charlie),
        );

        expect(processor.isComplete()).toBe(true);
      });

      it('should not be complete with extra items', () => {
        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 1, alice),
        );
        processor.processEvent(createEvent(GraphQLRowOperation.Insert, 2, bob));
        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 3, charlie),
        );

        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 4, {
            id: 4,
            name: 'David',
            age: 40,
          }),
        );

        expect(processor.isComplete()).toBe(false); // Has extra item
      });

      it('should handle completion through updates', () => {
        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 1, {
            ...alice,
            age: 29,
          }),
        );
        processor.processEvent(
          createEvent(GraphQLRowOperation.Update, 1, alice),
        );
        processor.processEvent(createEvent(GraphQLRowOperation.Insert, 2, bob));
        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 3, charlie),
        );

        expect(processor.isComplete()).toBe(true);
      });
    });

    describe('edge cases', () => {
      it('should handle null/undefined fields', () => {
        processor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 1, {
            id: 1,
            name: 'Alice',
            age: null,
          }),
        );

        expect(processor.getStats().totalReceived).toBe(1);
      });

      it('should handle complex nested objects', () => {
        const profile = {
          id: 1,
          profile: { name: 'Alice', settings: { theme: 'dark' } },
        };
        const complexProcessor = new SubscriptionProcessor(
          new Map([[1, profile]]),
          'data',
        );

        complexProcessor.processEvent(
          createEvent(GraphQLRowOperation.Insert, 1, profile),
        );

        expect(complexProcessor.isComplete()).toBe(true);
      });
    });
  });

  describe('with empty expected state', () => {
    beforeEach(() => {
      processor = new SubscriptionProcessor(
        new Map(), // Empty expected state
        'data',
      );
    });

    it('should be complete immediately', () => {
      expect(processor.isComplete()).toBe(true);
    });

    it('should not be complete after receiving events', () => {
      processor.processEvent(
        createEvent(GraphQLRowOperation.Insert, 1, { id: 1, name: 'Alice' }),
      );

      expect(processor.isComplete()).toBe(false); // Has unexpected item
    });
  });
});
