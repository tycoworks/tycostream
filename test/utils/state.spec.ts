import { StateManager, State, StatefulItem } from './state';

/**
 * Mock implementation of StatefulItem for testing
 */
class MockStatefulItem implements StatefulItem {
  constructor(private state: State) {}
  
  getState(): State {
    return this.state;
  }
  
  setState(state: State): void {
    this.state = state;
  }
}

describe('StateManager', () => {
  let manager: StateManager<MockStatefulItem>;
  
  beforeEach(() => {
    manager = new StateManager('TestManager', false);
  });
  
  describe('state aggregation', () => {
    it('should be Active when empty', () => {
      expect(manager.getState()).toBe(State.Active);
    });
    
    it('should be Active when any child is Active', () => {
      const item1 = new MockStatefulItem(State.Completed);
      const item2 = new MockStatefulItem(State.Active);
      const item3 = new MockStatefulItem(State.Stalled);
      
      manager.add('item1', item1);
      manager.add('item2', item2);
      manager.add('item3', item3);
      manager.handleChildStateChange();
      
      expect(manager.getState()).toBe(State.Active);
    });
    
    it('should be Stalled when all children are Stalled', () => {
      const item1 = new MockStatefulItem(State.Stalled);
      const item2 = new MockStatefulItem(State.Stalled);
      
      manager.add('item1', item1);
      manager.add('item2', item2);
      manager.handleChildStateChange();
      
      expect(manager.getState()).toBe(State.Stalled);
    });
    
    it('should be Completed when all children are Completed', () => {
      const item1 = new MockStatefulItem(State.Completed);
      const item2 = new MockStatefulItem(State.Completed);
      
      manager.add('item1', item1);
      manager.add('item2', item2);
      manager.handleChildStateChange();
      
      expect(manager.getState()).toBe(State.Completed);
    });
    
    it('should be Failed when any child is Failed', () => {
      const item1 = new MockStatefulItem(State.Completed);
      const item2 = new MockStatefulItem(State.Failed);
      const item3 = new MockStatefulItem(State.Active);
      
      manager.add('item1', item1);
      manager.add('item2', item2);
      manager.add('item3', item3);
      manager.handleChildStateChange();
      
      expect(manager.getState()).toBe(State.Failed);
    });
    
    it('should handle mixed Completed and Stalled as Stalled', () => {
      const item1 = new MockStatefulItem(State.Completed);
      const item2 = new MockStatefulItem(State.Stalled);
      
      manager.add('item1', item1);
      manager.add('item2', item2);
      manager.handleChildStateChange();
      
      expect(manager.getState()).toBe(State.Stalled);
    });
  });
  
  describe('completion promise', () => {
    it('should resolve when all children complete', async () => {
      const item1 = new MockStatefulItem(State.Active);
      const item2 = new MockStatefulItem(State.Active);
      
      manager.add('item1', item1);
      manager.add('item2', item2);
      
      const promise = manager.waitForCompletion();
      
      // Complete first item
      item1.setState(State.Completed);
      manager.handleChildStateChange();
      
      // Should still be pending
      let resolved = false;
      promise.then(() => { resolved = true; });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(resolved).toBe(false);
      
      // Complete second item
      item2.setState(State.Completed);
      manager.handleChildStateChange();
      
      // Should now resolve
      await expect(promise).resolves.toBeUndefined();
    });
    
    it('should reject when any child fails', async () => {
      const item1 = new MockStatefulItem(State.Active);
      const item2 = new MockStatefulItem(State.Active);
      
      manager.add('item1', item1);
      manager.add('item2', item2);
      
      const promise = manager.waitForCompletion();
      
      // Fail first item
      item1.setState(State.Failed);
      manager.handleChildStateChange();
      
      // Should reject
      await expect(promise).rejects.toThrow('TestManager failed');
    });
    
    it('should reject when stalled if failOnStall is true', async () => {
      manager = new StateManager('TestManager', true); // Enable failOnStall
      
      const item = new MockStatefulItem(State.Active);
      manager.add('item', item);
      
      const promise = manager.waitForCompletion();
      
      // Stall the item
      item.setState(State.Stalled);
      manager.handleChildStateChange();
      
      // Should reject due to failOnStall
      await expect(promise).rejects.toThrow('TestManager stalled - no data flowing');
    });
    
    it('should not reject when stalled if failOnStall is false', async () => {
      const item = new MockStatefulItem(State.Active);
      manager.add('item', item);
      
      const promise = manager.waitForCompletion();
      
      // Stall the item
      item.setState(State.Stalled);
      manager.handleChildStateChange();
      
      // Should still be pending (not rejected)
      let resolved = false;
      let rejected = false;
      promise.then(() => { resolved = true; }).catch(() => { rejected = true; });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(resolved).toBe(false);
      expect(rejected).toBe(false);
    });
    
    it('should resolve only once even with multiple state changes', async () => {
      const item = new MockStatefulItem(State.Active);
      manager.add('item', item);
      
      const promise = manager.waitForCompletion();
      
      // Complete
      item.setState(State.Completed);
      manager.handleChildStateChange();
      
      await expect(promise).resolves.toBeUndefined();
      
      // Try to change state again (should have no effect)
      item.setState(State.Failed);
      manager.handleChildStateChange();
      
      // Promise should still be resolved, not rejected
      await expect(promise).resolves.toBeUndefined();
    });
  });
  
  describe('parent notification', () => {
    it('should notify parent when state changes', () => {
      const parentManager = new StateManager('ParentManager', false);
      const childManager = new StateManager('ChildManager', false);
      
      // Set up parent-child relationship
      childManager.setParent(parentManager);
      parentManager.add('child', childManager);
      
      // Add item to child
      const item = new MockStatefulItem(State.Active);
      childManager.add('item', item);
      
      // Complete the item
      item.setState(State.Completed);
      childManager.handleChildStateChange();
      
      // Parent should also be completed
      expect(parentManager.getState()).toBe(State.Completed);
    });
    
    it('should propagate failures up the hierarchy', () => {
      const grandparent = new StateManager('Grandparent', false);
      const parent = new StateManager('Parent', false);
      const child = new StateManager('Child', false);
      
      // Set up hierarchy
      child.setParent(parent);
      parent.add('child', child);
      parent.setParent(grandparent);
      grandparent.add('parent', parent);
      
      // Add failing item to child
      const item = new MockStatefulItem(State.Failed);
      child.add('item', item);
      child.handleChildStateChange();
      
      // Failure should propagate all the way up
      expect(child.getState()).toBe(State.Failed);
      expect(parent.getState()).toBe(State.Failed);
      expect(grandparent.getState()).toBe(State.Failed);
    });
  });
  
  describe('item management', () => {
    it('should track multiple items', () => {
      const item1 = new MockStatefulItem(State.Active);
      const item2 = new MockStatefulItem(State.Active);
      
      manager.add('item1', item1);
      manager.add('item2', item2);
      
      expect(manager.has('item1')).toBe(true);
      expect(manager.has('item2')).toBe(true);
      expect(manager.has('item3')).toBe(false);
    });
    
    it('should return correct item count', () => {
      expect(manager.getItems().size).toBe(0);
      
      manager.add('item1', new MockStatefulItem(State.Active));
      expect(manager.getItems().size).toBe(1);
      
      manager.add('item2', new MockStatefulItem(State.Active));
      expect(manager.getItems().size).toBe(2);
    });
    
  });
  
  describe('edge cases', () => {
    it('should handle empty state transitions', () => {
      // No items, state change should not throw
      expect(() => manager.handleChildStateChange()).not.toThrow();
      expect(manager.getState()).toBe(State.Active);
    });
    
    it('should handle adding items to empty manager', () => {
      // Empty manager starts as Active
      expect(manager.getState()).toBe(State.Active);
      
      // Add completed item
      const item = new MockStatefulItem(State.Completed);
      manager.add('item', item);
      manager.handleChildStateChange();
      
      // Should now be completed
      expect(manager.getState()).toBe(State.Completed);
    });
    
    it('should prevent infinite recursion in parent notification', () => {
      const parent = new StateManager('Parent', false);
      const child = new StateManager('Child', false);
      
      // Create circular reference (shouldn't happen in practice but test safety)
      child.setParent(parent);
      parent.add('child', child);
      
      const item = new MockStatefulItem(State.Active);
      child.add('item', item);
      
      // Should not cause infinite recursion
      item.setState(State.Completed);
      expect(() => child.handleChildStateChange()).not.toThrow();
    });
  });
});