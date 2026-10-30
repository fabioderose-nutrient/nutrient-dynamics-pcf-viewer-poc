/**
 * Audit and engagement tracking for the Nutrient PDF Viewer PCF control.
 *
 * The tracker is viewer-agnostic: the control forwards raw viewer events
 * (page change, download, print, lifecycle) and the tracker turns them into
 * a normalized audit event stream pushed to one or more sinks
 * (Dataverse Web API, on-screen audit panel, console).
 */

/**
 * Core lifecycle events are listed below; interaction events (ZoomChanged,
 * AnnotationCreated, SearchPerformed, TextCopied, ...) are emitted through
 * interaction() with a free-form type name so new viewer events can be wired
 * without touching this file.
 */
export type AuditEventType =
    | "DocumentOpened"
    | "PageViewed"
    | "PageLeft"
    | "DocumentDownloaded"
    | "DocumentPrinted"
    | "ViewPaused"
    | "ViewResumed"
    | "DocumentClosed"
    | "SessionSummary"
    | (string & {});

export interface AuditEvent {
    sessionId: string;
    eventType: AuditEventType;
    userId: string;
    userName: string;
    documentName: string;
    documentUrl: string;
    pageNumber?: number;
    pageCount?: number;
    durationSeconds?: number;
    detail?: string;
    /** Full structured payload (JSON), e.g. the complete annotation object. */
    payload?: string;
    timestamp: string;
}

export interface SessionStats {
    sessionId: string;
    userName: string;
    documentName: string;
    pageCount: number;
    currentPage: number;
    lastPageViewed: number;
    pagesViewed: number[];
    /** Cumulative seconds per page, keyed by 1-based page number. */
    timePerPage: Record<number, number>;
    totalSeconds: number;
    /** 0..1 share of pages viewed at least once. */
    readProgress: number;
    downloads: number;
    prints: number;
    /** Count of every interaction event type recorded this session. */
    counters: Record<string, number>;
}

export type AuditSink = (event: AuditEvent) => void;
export type StatsListener = (stats: SessionStats) => void;

interface TrackerContext {
    userId: string;
    userName: string;
    documentName: string;
    documentUrl: string;
}

export class AuditTracker {
    private readonly sessionId: string;
    private readonly sessionStart: number;
    private pageEnter: number;
    private currentPage = 1;
    private lastPageViewed = 1;
    private pageCount = 0;
    private readonly pagesViewed = new Set<number>();
    private readonly timePerPage = new Map<number, number>();
    private downloads = 0;
    private prints = 0;
    private readonly counters = new Map<string, number>();
    private paused = false;
    private closed = false;

    constructor(
        private readonly ctx: TrackerContext,
        private readonly sinks: AuditSink[],
        private readonly statsListener?: StatsListener
    ) {
        this.sessionId = "sess-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
        this.sessionStart = performance.now();
        this.pageEnter = this.sessionStart;
    }

    documentOpened(pageCount: number): void {
        this.pageCount = pageCount;
        this.pagesViewed.add(1);
        this.emit("DocumentOpened", { pageCount });
        this.emit("PageViewed", { pageNumber: 1 });
        this.notifyStats();
    }

    /** newPageIndex is 0-based, as emitted by the Nutrient Web SDK. */
    pageChanged(newPageIndex: number): void {
        if (this.closed) return;
        const newPage = newPageIndex + 1;
        if (newPage === this.currentPage) return;
        this.flushCurrentPageTime();
        this.emit("PageLeft", {
            pageNumber: this.currentPage,
            durationSeconds: round1(this.timePerPage.get(this.currentPage) ?? 0),
        });
        this.currentPage = newPage;
        this.lastPageViewed = newPage;
        this.pagesViewed.add(newPage);
        this.pageEnter = performance.now();
        this.emit("PageViewed", { pageNumber: newPage });
        this.notifyStats();
    }

    /**
     * Records any viewer interaction (zoom, annotation, search, copy, ...) as
     * an audit event. The page defaults to the page currently displayed.
     */
    interaction(eventType: string, detail?: string, pageNumber?: number, payload?: string): void {
        if (this.closed) return;
        this.counters.set(eventType, (this.counters.get(eventType) ?? 0) + 1);
        this.emit(eventType, { detail, pageNumber: pageNumber ?? this.currentPage, payload });
        this.notifyStats();
    }

    documentDownloaded(): void {
        this.downloads++;
        this.emit("DocumentDownloaded", { pageNumber: this.currentPage });
        this.notifyStats();
    }

    documentPrinted(): void {
        this.prints++;
        this.emit("DocumentPrinted", { pageNumber: this.currentPage });
        this.notifyStats();
    }

    /** Pause/resume page timers when the tab or app loses visibility. */
    visibilityChanged(hidden: boolean): void {
        if (this.closed || hidden === this.paused) return;
        if (hidden) {
            this.flushCurrentPageTime();
            this.paused = true;
            this.emit("ViewPaused", { pageNumber: this.currentPage });
        } else {
            this.paused = false;
            this.pageEnter = performance.now();
            this.emit("ViewResumed", { pageNumber: this.currentPage });
        }
    }

    close(): void {
        if (this.closed) return;
        this.flushCurrentPageTime();
        this.closed = true;
        const stats = this.stats();
        this.emit("DocumentClosed", {
            pageNumber: this.currentPage,
            durationSeconds: stats.totalSeconds,
        });
        this.emit("SessionSummary", {
            durationSeconds: stats.totalSeconds,
            detail: JSON.stringify({
                pagesViewed: stats.pagesViewed,
                lastPageViewed: stats.lastPageViewed,
                timePerPage: stats.timePerPage,
                readProgress: stats.readProgress,
                downloads: stats.downloads,
                prints: stats.prints,
                interactions: stats.counters,
            }),
        });
        this.notifyStats();
    }

    stats(): SessionStats {
        const timePerPage: Record<number, number> = {};
        this.timePerPage.forEach((secs, page) => (timePerPage[page] = round1(secs)));
        // Include time accrued on the page currently open.
        if (!this.paused && !this.closed) {
            const live = (performance.now() - this.pageEnter) / 1000;
            timePerPage[this.currentPage] = round1((this.timePerPage.get(this.currentPage) ?? 0) + live);
        }
        const totalSeconds = round1(Object.values(timePerPage).reduce((a, b) => a + b, 0));
        return {
            sessionId: this.sessionId,
            userName: this.ctx.userName,
            documentName: this.ctx.documentName,
            pageCount: this.pageCount,
            currentPage: this.currentPage,
            lastPageViewed: this.lastPageViewed,
            pagesViewed: Array.from(this.pagesViewed).sort((a, b) => a - b),
            timePerPage,
            totalSeconds,
            readProgress: this.pageCount > 0 ? this.pagesViewed.size / this.pageCount : 0,
            downloads: this.downloads,
            prints: this.prints,
            counters: Object.fromEntries(this.counters),
        };
    }

    private flushCurrentPageTime(): void {
        if (this.paused) return;
        const now = performance.now();
        const elapsed = (now - this.pageEnter) / 1000;
        this.timePerPage.set(this.currentPage, (this.timePerPage.get(this.currentPage) ?? 0) + elapsed);
        this.pageEnter = now;
    }

    private emit(eventType: AuditEventType, extra: Partial<AuditEvent>): void {
        const event: AuditEvent = {
            sessionId: this.sessionId,
            eventType,
            userId: this.ctx.userId,
            userName: this.ctx.userName,
            documentName: this.ctx.documentName,
            documentUrl: this.ctx.documentUrl,
            pageCount: this.pageCount || undefined,
            timestamp: new Date().toISOString(),
            ...extra,
        };
        for (const sink of this.sinks) {
            try {
                sink(event);
            } catch (e) {
                console.warn("Audit sink failed", e);
            }
        }
    }

    private notifyStats(): void {
        this.statsListener?.(this.stats());
    }
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}
