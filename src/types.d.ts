import type * as vscode from 'vscode';
import type { ActivityStore } from './storage';

export interface EditedFile { id: string; path: string }
export type MilestoneKind = 'dailyGoal' | 'streak';
export interface Milestone { kind: MilestoneKind; seconds: number }
export interface ActivityChange {
  date: string; projectId: string; projectName: string;
  languageId?: string; seconds?: number; characters?: number; file?: EditedFile;
}
export interface ProjectActivity {
  name: string; time: number; characters: number;
  files: Record<string, string>; languages?: Record<string, number>;
}
export interface ActivityDay { projects: Record<string, ProjectActivity> }
export interface ActivityData { version: 2 | 3; days: Record<string, ActivityDay> }
export interface DaySummary {
  time: number; characters: number;
  files: (EditedFile & { projectId: string; projectName: string })[];
}
export interface SummaryOptions {
  today?: string; projectId?: string; dailyGoalMinutes?: number;
  streakMinimumMinutes?: number; weekStartsOn?: number;
  includeFilesForDate?: string;
  dayCache?: WeakMap<ActivityDay, Map<string, DaySummary>>;
}
export interface PeriodActivity {
  start: string; end: string; totalSeconds: number; activeDays: number;
  averageSeconds: number; goalDays: number | null;
  projects: { id: string; name: string; seconds: number }[];
  languages: { id: string; seconds: number }[];
}
export interface RangeReport extends PeriodActivity {
  comparisonStart: string; comparisonEnd: string; previousSeconds: number;
  changeSeconds: number; changePercent: number | null;
}
export interface SummaryResult {
  days: Record<string, DaySummary>;
  projects: { id: string; name: string }[];
  insights: {
    start: string; end: string; comparisonStart: string; comparisonEnd: string;
    previousSeconds: number; changeSeconds: number; changePercent: number | null;
    activeDays: number; averageSeconds: number; goalDays: number | null;
  };
  breakdown: { week: PeriodActivity; month: PeriodActivity };
  summary: {
    todaySeconds: number; weekSeconds: number; currentStreak: number; longestStreak: number;
    goalSeconds: number; qualifyingSeconds: number;
  };
}
export interface DashboardSnapshot extends SummaryResult {
  type: 'snapshot'; today: string; status: 'tracking' | 'idle' | 'paused'; paused: boolean;
  projectId: string; weekStartsOn: number; selectedDate: string; recoveryRequired: boolean;
  storageError: string; report: RangeReport | null; revision?: number;
  saveStatus: 'saving' | 'saved' | 'error'; saveError: string; hasHistory: boolean;
}
export type DashboardPatch = Omit<DashboardSnapshot, 'type'> & {
  type: 'patch'; baseRevision: number; revision: number; removedDays: string[];
};
export type DashboardMessage = DashboardSnapshot | DashboardPatch;
export type DashboardRequest =
  | { type: 'ready' }
  | { type: 'filter'; projectId: string }
  | { type: 'selectDate'; date: string }
  | { type: 'report'; start: string; end: string }
  | { type: 'togglePause' | 'settings' | 'setDailyGoal' | 'retrySave' | 'exportJson' | 'exportCsv' | 'importJson' | 'clearHistory' | 'recoverHistory' };
export interface TrackerContext {
  focused: boolean; active: boolean; eligible: boolean;
  projectId: string; projectName: string; languageId?: string;
}
export interface TrackerOptions {
  onChange: (change: ActivityChange) => void; now?: () => number;
  idleTimeoutMs?: number; maxGapMs?: number;
}
export interface ControllerOptions {
  now?: () => number; timers?: boolean; store?: ActivityStore;
  getWebviewHTML?: (webview: vscode.Webview, uri: vscode.Uri) => string;
}

export interface DashboardElements {
  [id: string]: HTMLElement;
  'project-filter': HTMLSelectElement;
  'goal-progress': HTMLProgressElement;
  'data-menu': HTMLDetailsElement;
  'pause-button': HTMLButtonElement;
  'previous-period': HTMLButtonElement;
  'next-period': HTMLButtonElement;
  'report-start': HTMLInputElement;
  'report-end': HTMLInputElement;
}
declare global {
  function acquireVsCodeApi(): {
    getState(): Record<string, unknown> | undefined;
    setState(state: Record<string, unknown>): void;
    postMessage(message: DashboardRequest): void;
  };
}
