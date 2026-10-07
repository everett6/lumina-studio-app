// Read-only search over the user's work, in the shape ChatGPT connectors and deep research expect from `search`
// and `fetch` tools: documents with a stable id ("<type>:<uuid>"), a title and full text.

const words = (query) => String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);

export function createSearch(repo) {
  // Every searchable document, built on demand (projects are small enough to scan).
  function* documents() {
    for (const project of repo.projects.list()) {
      const books = repo.books.listByProject(project.id);
      const boards = repo.sequences.listByProject(project.id);
      yield {
        id: `project:${project.id}`, title: `Project: ${project.name}`,
        text: [`Project "${project.name}".`, books.length ? `Books: ${books.map((b) => b.title).join(', ')}.` : '', boards.length ? `Storyboards: ${boards.map((s) => s.title).join(', ')}.` : ''].filter(Boolean).join('\n'),
        metadata: { type: 'project', projectId: project.id },
      };
      for (const book of books) {
        const full = repo.books.get(book.id);
        const pages = repo.pages.listByBook(book.id);
        const chapters = repo.chapters.listByBook(book.id);
        yield {
          id: `book:${book.id}`, title: `Book: ${full.title}`,
          text: [
            `${full.title} (${full.kind}) in project "${project.name}".`,
            Object.keys(full.brief ?? {}).length ? `Brief: ${JSON.stringify(full.brief)}` : '',
            chapters.length ? `Chapters:\n${chapters.map((c) => `${c.position}. ${c.title}${c.summary ? ` — ${c.summary}` : ''}`).join('\n')}` : '',
            pages.length ? `Pages:\n${pages.map((p) => `${p.position}. ${p.text}`).join('\n')}` : '',
          ].filter(Boolean).join('\n\n'),
          metadata: { type: 'book', projectId: project.id, bookId: book.id, kind: full.kind },
        };
        for (const chapter of chapters) {
          yield {
            id: `chapter:${chapter.id}`, title: `${full.title} — ${chapter.title}`,
            text: [chapter.summary ? `Summary: ${chapter.summary}` : '', chapter.text ?? ''].filter(Boolean).join('\n\n'),
            metadata: { type: 'chapter', projectId: project.id, bookId: book.id, chapterId: chapter.id, position: chapter.position },
          };
        }
      }
      for (const board of boards) {
        const shots = repo.shots.listBySequence(board.id);
        yield {
          id: `storyboard:${board.id}`, title: `Storyboard: ${board.title}`,
          text: [`Idea: ${board.idea}`, shots.map((s) => `Shot ${s.position} (${s.duration ?? '?'} s${s.camera ? `, ${s.camera}` : ''}): ${s.description}`).join('\n')].filter(Boolean).join('\n\n'),
          metadata: { type: 'storyboard', projectId: project.id, storyboardId: board.id, shots: shots.length },
        };
      }
    }
    for (const character of repo.characters.list()) {
      yield {
        id: `character:${character.id}`, title: `Character: ${character.name}`, text: character.description || '(no description)',
        metadata: { type: 'character', characterId: character.id, kind: character.kind },
      };
    }
  }

  return {
    // Ranked by how many query words appear (title matches count double). An empty query lists everything.
    search(query, limit = 20) {
      const terms = words(query);
      const scored = [];
      for (const doc of documents()) {
        const title = doc.title.toLowerCase();
        const body = doc.text.toLowerCase();
        const score = terms.length ? terms.reduce((sum, t) => sum + (title.includes(t) ? 2 : 0) + (body.includes(t) ? 1 : 0), 0) : 1;
        if (score > 0) scored.push({ doc, score });
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ doc }) => doc);
    },
    fetch(id) {
      for (const doc of documents()) if (doc.id === id) return doc;
      return null;
    },
  };
}
