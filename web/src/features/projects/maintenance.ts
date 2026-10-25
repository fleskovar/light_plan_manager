import type { BoardBackupDto, StoreJobDto } from '$shared';
import type { Confirmation } from '$lib/app/shell.svelte.js';

/**
 * The rules that the "All projects" page and the Storage tab of the board
 * configuration share: the move, backup and restore of a board.
 *
 * The functions here are pure. They build the text of a row, the progress of
 * a background job and the confirmation that each action asks for. The two
 * view-models (`projects.svelte.ts`, `config/storage.svelte.ts`) call them, so
 * both places ask the same questions in the same words.
 */

/** The word that the reader types to replace the backup of a board. The server checks the same word. */
export const CONFIRM_BACKUP = 'backup';
/** The word that the reader types to restore a board from its backup. The server checks the same word. */
export const CONFIRM_RESTORE = 'restore';

const DAY_MS = 86_400_000;

/** The whole days from `createdAt` to `now`. A backup from less than 24 hours ago is 0 days old. */
export function ageInDays(createdAt: string, now: Date = new Date()): number {
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((now.getTime() - at) / DAY_MS));
}

/** "0 days", "1 day", "12 days". */
export function ageText(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/** The time of a backup in the local time zone, as `YYYY-MM-DD HH:MM`. */
export function backupDateText(createdAt: string): string {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return createdAt;
  return `${at.getFullYear()}-${twoDigits(at.getMonth() + 1)}-${twoDigits(at.getDate())} ${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;
}

/** A byte count with the unit that keeps the number below 1024: "512 B", "14.2 KB", "3.1 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** The newest job of the project folder `root`, or undefined. */
export function jobFor(jobs: readonly StoreJobDto[], root: string | null): StoreJobDto | undefined {
  if (root === null) return undefined;
  for (let index = jobs.length - 1; index >= 0; index--) {
    if (jobs[index]!.root === root) return jobs[index];
  }
  return undefined;
}

/**
 * The share of the job that is done, from 0 to 100. Each step has the same
 * share. Inside a step, the copy is the first half and the comparison of the
 * copy is the second half.
 */
export function jobPercent(job: StoreJobDto): number {
  if (job.state !== 'running') return 100;
  if (job.stepCount === 0) return 0;
  const phaseShare = job.total > 0 ? job.done / job.total : 1;
  const stepShare = job.phase === 'compare' ? 0.5 + phaseShare / 2 : phaseShare / 2;
  const share = (job.stepIndex - 1 + stepShare) / job.stepCount;
  return Math.max(0, Math.min(100, Math.round(share * 100)));
}

const STEP_TEXT: Record<NonNullable<StoreJobDto['step']>, string> = {
  backup: 'Backing up',
  copy: 'Copying the board',
  restore: 'Restoring',
};

/** One line about a job: "Step 1 of 2: Backing up, checking the copy (40%)", or the result. */
export function jobText(job: StoreJobDto): string {
  if (job.state === 'done') return job.message ?? 'Done.';
  if (job.state === 'failed') return `Failed: ${job.message ?? 'unknown error'}`;
  if (job.step === null) return 'Starting…';
  const step = `${STEP_TEXT[job.step]}${job.phase === 'compare' ? ', checking the copy' : ''}`;
  const where = job.stepCount > 1 ? `Step ${job.stepIndex} of ${job.stepCount}: ` : '';
  return `${where}${step} (${jobPercent(job)}%)`;
}

/** The text on the button that moves a board. */
export function moveLabel(store: 'local' | 'central'): string {
  return store === 'local' ? 'Move to central' : 'Move to project';
}

/** The details that describe a backup in a confirmation. */
function backupLine(backup: BoardBackupDto, now: Date): string {
  return `The current backup is from ${backupDateText(backup.createdAt)} (${ageText(ageInDays(backup.createdAt, now))} old).`;
}

export interface MoveRequest {
  name: string;
  /** Where the board is now. The move goes to the other store. */
  store: 'local' | 'central';
  /** The project folder. */
  root: string;
  /** The central store, for the text of a move to it. */
  centralStore: string | null;
  backup: BoardBackupDto | null;
  now?: Date;
  onConfirm: () => void;
}

/** The confirmation of a move between the project and the central store. */
export function moveConfirmation(request: MoveRequest): Confirmation {
  const now = request.now ?? new Date();
  const toCentral = request.store === 'local';
  const target = toCentral
    ? `the central store${request.centralStore ? ` (${request.centralStore}/.lpm_central)` : ''}`
    : `${request.root}/.lpm`;
  return {
    title: toCentral ? `Move ${request.name} to the central store?` : `Move ${request.name} into its project?`,
    message: `The board of ${request.name} moves to ${target}. The copy runs in the background, and the row shows its progress.`,
    details: [
      'First, the board is backed up into the central store, in .lpm_backups. The backup replaces the earlier backup of this board.',
      ...(request.backup ? [backupLine(request.backup, now)] : []),
      'Then the board is copied and the copy is compared with the original. The original is deleted only after the copy matches.',
      'Do not run other lpm commands on this board during the move. Stop other lpm ui or lpm mcp processes on it, and start them again after.',
    ],
    confirmLabel: 'Move',
    onConfirm: () => request.onConfirm(),
  };
}

export interface BackupRequest {
  name: string;
  backup: BoardBackupDto | null;
  now?: Date;
  /** Receives the word to send to the server: `backup` when a backup is replaced, otherwise undefined. */
  onConfirm: (confirm: string | undefined) => void;
}

/**
 * The confirmation of a backup. A board has one backup. When it has one, the
 * new backup replaces it, and the reader must type `backup`.
 */
export function backupConfirmation(request: BackupRequest): Confirmation {
  const now = request.now ?? new Date();
  if (!request.backup) {
    return {
      title: `Back up ${request.name}?`,
      message: `A full copy of the board of ${request.name} goes to the central store, in .lpm_backups.`,
      details: ['Each board has one backup. A later backup replaces this one.'],
      confirmLabel: 'Back up',
      onConfirm: () => request.onConfirm(undefined),
    };
  }
  return {
    title: `Replace the backup of ${request.name}?`,
    message: `${request.name} has a backup already. Each board has one backup, so the new backup overwrites it.`,
    details: [backupLine(request.backup, now), `The backup folder is ${request.backup.dir}.`],
    confirmLabel: 'Continue',
    danger: true,
    typeToConfirm: CONFIRM_BACKUP,
    onConfirm: () => request.onConfirm(CONFIRM_BACKUP),
  };
}

export interface RestoreRequest {
  backup: BoardBackupDto;
  now?: Date;
  onConfirm: (confirm: string) => void;
}

/** The confirmation of a restore. A restore overwrites the board, so the reader must type `restore`. */
export function restoreConfirmation(request: RestoreRequest): Confirmation {
  const now = request.now ?? new Date();
  const name = projectName(request.backup.projectPath);
  return {
    title: `Restore ${name} from its backup?`,
    message: `This overwrites every file of the board of ${name} with the copy in the backup. Changes made after the backup are lost.`,
    details: [
      `The backup is from ${backupDateText(request.backup.createdAt)} (${ageText(ageInDays(request.backup.createdAt, now))} old).`,
      `The project folder is ${request.backup.projectPath}. The board stays where it is now, in the project or in the central store.`,
      'The backup itself does not change.',
    ],
    confirmLabel: 'Continue',
    danger: true,
    typeToConfirm: CONFIRM_RESTORE,
    onConfirm: () => request.onConfirm(CONFIRM_RESTORE),
  };
}

/** The last folder name of a path, with `/` or `\` as separator. */
export function projectName(folder: string): string {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? folder;
}
