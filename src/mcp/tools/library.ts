import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LibraryDoc, LoadedBoard } from '../../core/index.js';
import {
  BoardError,
  createLibraryDoc,
  displayPath,
  libraryReferrers,
  listLibraryDocs,
  moveLibraryDoc,
  readLibraryDoc,
  removeLibraryDoc,
  updateLibraryDoc,
} from '../../core/index.js';
import type { BoardContext } from '../context.js';
import { guard, json } from '../reply.js';

/**
 * The board library, as an agent sees it: the markdown documents in
 * `.lpm/library/`. `list_library` and `get_library_document` read. The four
 * write tools register only on a server that is not read-only, and each one
 * calls one operation of `core/operations/library.ts`.
 */
function summary(board: LoadedBoard, doc: LibraryDoc) {
  return {
    id: doc.id,
    ref: `library:${doc.id}`,
    title: doc.title,
    description: doc.description,
    path: displayPath(board.paths, doc.file),
    updated: doc.updated,
  };
}

const ID_DESCRIPTION =
  'The library id: the path below .lpm/library without ".md", for example "prompts/code-review"';

export function registerLibraryTools(server: McpServer, context: BoardContext): void {
  server.registerTool(
    'list_library',
    {
      title: 'List the library documents',
      description:
        'The board library: markdown documents stored beside the issues, such as prompts with ' +
        'instructions, summaries of developments and product requirement documents. Returns ' +
        'the id, the title and the description of each document, without the bodies. An issue ' +
        'references a document with the related file "library:<id>"; get_instructions prints ' +
        'every document that an issue or its ancestors reference.',
      inputSchema: {
        search: z.string().optional().describe('Match against the id, the title and the description'),
      },
      annotations: { readOnlyHint: true },
    },
    guard((args) => {
      const board = context.board();
      const wanted = args.search?.trim().toLowerCase();
      const docs = listLibraryDocs(board.paths).filter(
        (doc) => !wanted || [doc.id, doc.title, doc.description].join(' ').toLowerCase().includes(wanted),
      );
      return json({
        documents: docs.map((doc) => summary(board, doc)),
        total: docs.length,
        hint: docs.length
          ? 'Use get_library_document for the body of one document.'
          : 'The library is empty.',
      });
    }),
  );

  server.registerTool(
    'get_library_document',
    {
      title: 'Read one library document',
      description:
        'One document of the board library: its title, its description, its markdown body, ' +
        'its revision and the ids of the issues and templates that reference it. Pass the ' +
        'revision to update_library_document so that the update fails when somebody changed ' +
        'the document after you read it.',
      inputSchema: { id: z.string().describe(ID_DESCRIPTION) },
      annotations: { readOnlyHint: true },
    },
    guard((args) => {
      const board = context.board();
      const doc = readLibraryDoc(board.paths, args.id);
      if (!doc) throw new BoardError(`The library has no document "${args.id}"`, ['list_library lists them.']);
      return json({
        ...summary(board, doc),
        revision: doc.revision,
        body: doc.body,
        referencedBy: libraryReferrers(board, doc.id),
      });
    }),
  );

  if (context.readOnly) return;

  server.registerTool(
    'create_library_document',
    {
      title: 'Add a library document',
      description:
        'Write a new markdown document to .lpm/library/<id>.md. Use it for text that belongs ' +
        'beside the plan and is not a piece of it: a prompt, a summary of what was built, a ' +
        'requirements document. To make an issue reference it, add "library:<id>" to the ' +
        'relatedFiles of the issue with update_document.',
      inputSchema: {
        id: z.string().describe(ID_DESCRIPTION),
        title: z.string().optional().describe('Without one, the first "# " heading of the body, or the id'),
        description: z.string().optional().describe('One line that says what the document is for'),
        body: z.string().default('').describe('The markdown body'),
      },
    },
    guard((args) => {
      context.assertWritable();
      const board = context.board();
      const doc = createLibraryDoc(board, args);
      return json({ created: summary(board, doc), revision: doc.revision });
    }),
  );

  server.registerTool(
    'update_library_document',
    {
      title: 'Change a library document',
      description:
        'Change the title, the description or the body of a library document. A field that ' +
        'you leave out keeps its value. The body replaces the whole body.',
      inputSchema: {
        id: z.string().describe(ID_DESCRIPTION),
        title: z.string().optional(),
        description: z.string().optional(),
        body: z.string().optional(),
        revision: z
          .string()
          .optional()
          .describe('The revision from get_library_document. The update fails when the file holds another one'),
      },
    },
    guard((args) => {
      context.assertWritable();
      const board = context.board();
      const { id, ...input } = args;
      const doc = updateLibraryDoc(board, id, input);
      return json({ updated: summary(board, doc), revision: doc.revision });
    }),
  );

  server.registerTool(
    'move_library_document',
    {
      title: 'Rename or move a library document',
      description:
        'Give a library document a new id, which renames its file in .lpm/library. When "id" ' +
        'names a folder and no document, every document in the folder moves below "newId". ' +
        'By default the tool also rewrites each "library:<id>" related file and each ' +
        '"[label](library:<id>)" link of the issues and templates that reference a moved ' +
        'document. The answer lists each move and the ids whose references were rewritten.',
      inputSchema: {
        id: z.string().describe(`${ID_DESCRIPTION}, or a folder below .lpm/library`),
        newId: z.string().describe('The new id, or the new folder'),
        updateReferences: z
          .boolean()
          .default(true)
          .describe('Rewrite the references to the new ids. With false, check_board reports the old references'),
      },
    },
    guard((args) => {
      context.assertWritable();
      const board = context.board();
      const result = moveLibraryDoc(board, args.id, args.newId, { updateReferences: args.updateReferences });
      return json(result);
    }),
  );

  server.registerTool(
    'delete_library_document',
    {
      title: 'Delete a library document',
      description:
        'Delete .lpm/library/<id>.md. The references to it stay on the issues, and check_board ' +
        'reports them as warnings. The answer lists the issues and templates that still ' +
        'reference the document.',
      inputSchema: { id: z.string().describe(ID_DESCRIPTION) },
      annotations: { destructiveHint: true },
    },
    guard((args) => {
      context.assertWritable();
      const board = context.board();
      const result = removeLibraryDoc(board, args.id);
      return json({ deleted: result.doc.id, stillReferencedBy: result.referencedBy });
    }),
  );
}
