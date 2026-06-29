export class MemoryDraftRepository {
  constructor() {
    this.items = [];
  }

  async saveDraft(draft) {
    const item = { id: draft.id ?? `draft_${this.items.length + 1}`, ...draft };
    this.items.push(item);
    return item;
  }
}

export class MemoryAuditRepository {
  constructor() {
    this.items = [];
  }

  async write(event) {
    if (event) this.items.push(event);
  }
}
