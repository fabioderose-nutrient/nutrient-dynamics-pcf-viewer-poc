import { IInputs, IOutputs } from "./generated/ManifestTypes";
import { AuditTracker, AuditEvent, SessionStats } from "./AuditTracker";
import { createDataverseSink, createConsoleSink } from "./Sinks";

/* The Nutrient Web SDK is loaded at runtime from its CDN, so the PCF bundle stays small. */
/* eslint-disable @typescript-eslint/no-explicit-any */
const sdkWindow = window as unknown as { NutrientViewer?: any };

const SDK_URL = "https://cdn.cloud.pspdfkit.com/pspdfkit-web@1.10.0/nutrient-viewer.js";
const DEFAULT_DOCUMENT = "https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf";
/** Dataverse table receiving one row per audit event. */
const AUDIT_TABLE = "demo_documentauditevent";
/** Nutrient Web SDK license key. Empty = evaluation mode (watermark). Set it before packaging the solution. */
const LICENSE_KEY = "";

interface ViewerConfig {
    theme: "LIGHT" | "DARK";
    pageLayout: "SINGLE" | "DOUBLE";
    allowDownload: boolean;
    allowPrint: boolean;
    readOnly: boolean;
}

const ICON_DOWNLOAD =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16"/></svg>';
const ICON_PRINT =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V3h12v6M6 15H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-2m-12-1h12v7H6z"/></svg>';

export class NutrientPdfViewer implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private context: ComponentFramework.Context<IInputs>;
    private root: HTMLDivElement;
    private viewerHost: HTMLDivElement;
    private panel: {
        mode: HTMLElement;
        stats: HTMLElement;
        pageBars: HTMLElement;
        log: HTMLElement;
    };
    private instance: any;
    private tracker?: AuditTracker;
    private currentUrl = "";
    private tickTimer?: number;
    private latestStats?: SessionStats;
    private dataverseConnected = false;
    private prevViewState: Record<string, unknown> = {};
    private lastSaveStateDirty = false;
    private auditLog: AuditEvent[] = [];
    private reloadTimer?: number;
    private baseToolbarItems: any[] = [];
    private appliedConfig?: ViewerConfig;
    private readonly onVisibility = () => this.tracker?.visibilityChanged(document.hidden);
    private readonly onUnload = () => this.tracker?.close();

    public init(
        context: ComponentFramework.Context<IInputs>,
        _notifyOutputChanged: () => void,
        _state: ComponentFramework.Dictionary,
        container: HTMLDivElement
    ): void {
        this.context = context;
        context.mode.trackContainerResize(true);

        this.root = document.createElement("div");
        this.root.className = "audit-root";
        this.viewerHost = document.createElement("div");
        this.viewerHost.className = "audit-viewer";
        this.root.appendChild(this.viewerHost);
        this.root.appendChild(this.buildPanel());
        container.appendChild(this.root);

        document.addEventListener("visibilitychange", this.onVisibility);
        window.addEventListener("beforeunload", this.onUnload);

        this.applySize();
        this.rebrandHarnessSidebar();
        void this.loadDocument(this.resolveUrl());
    }

    /**
     * PoC nicety: the local PCF test harness titles its property sidebar with
     * the raw control name, which means nothing in a demo. Rename it to an
     * explicit label. Only runs outside Dataverse; retries because the harness
     * renders its sidebar asynchronously.
     */
    private rebrandHarnessSidebar(attempts = 10): void {
        if (this.isDataverseHost()) return;
        const heading = Array.from(document.querySelectorAll(".io-section h3, h3")).find(
            (h) => h.textContent?.trim() === "NutrientPdfViewer"
        );
        if (heading) {
            heading.textContent = "Microsoft PCF Simulator";
            const note = document.createElement("div");
            note.className = "audit-harness-note";
            note.textContent =
                "Local test harness simulating the Dynamics 365 form configuration. Document URL simulates the bound Dataverse column: paste any PDF URL to switch records.";
            heading.after(note);
        } else if (attempts > 0) {
            window.setTimeout(() => this.rebrandHarnessSidebar(attempts - 1), 500);
        }
    }

    public updateView(context: ComponentFramework.Context<IInputs>): void {
        this.context = context;
        this.applySize();
        const url = this.resolveUrl();
        if (url !== this.currentUrl) {
            // Debounced: in the harness every keystroke in the documentUrl
            // field triggers updateView with a partial URL.
            this.scheduleReload(url);
            return;
        }
        const cfg = this.resolveConfig();
        if (this.instance && this.appliedConfig && cfg.theme !== this.appliedConfig.theme) {
            // Theme is a load-time option of the Web SDK: reload the viewer.
            void this.loadDocument(this.currentUrl);
            return;
        }
        if (this.instance) this.applyViewConfig(false);
    }

    /** Reads the maker-facing configuration properties, with defaults. */
    private resolveConfig(): ViewerConfig {
        const p = this.context.parameters;
        return {
            theme: p.theme?.raw === "DARK" ? "DARK" : "LIGHT",
            pageLayout: p.pageLayout?.raw === "DOUBLE" ? "DOUBLE" : "SINGLE",
            allowDownload: p.allowDownload?.raw ?? true,
            allowPrint: p.allowPrint?.raw ?? true,
            readOnly: p.readOnly?.raw ?? false,
        };
    }

    /**
     * Applies the maker configuration to the live viewer instance. Every
     * change applied after load is itself recorded in the audit trail as a
     * ConfigChanged event.
     */
    private applyViewConfig(initial: boolean): void {
        const cfg = this.resolveConfig();
        const prev = this.appliedConfig;
        const NutrientViewer = sdkWindow.NutrientViewer;
        try {
            if (initial || cfg.allowDownload !== prev?.allowDownload || cfg.allowPrint !== prev?.allowPrint) {
                this.instance.setToolbarItems(() => this.filterToolbar(this.baseToolbarItems, cfg));
                if (!initial) {
                    this.tracker?.interaction("ConfigChanged", `allowDownload: ${cfg.allowDownload}, allowPrint: ${cfg.allowPrint}`);
                }
            }
            if (initial || cfg.readOnly !== prev?.readOnly) {
                this.instance.setViewState((vs: any) => vs.set("readOnly", cfg.readOnly));
                if (!initial) this.tracker?.interaction("ConfigChanged", `readOnly: ${cfg.readOnly}`);
            }
            if (initial || cfg.pageLayout !== prev?.pageLayout) {
                this.instance.setViewState((vs: any) => vs.set("layoutMode", NutrientViewer.LayoutMode[cfg.pageLayout]));
                if (!initial) this.tracker?.interaction("ConfigChanged", `pageLayout: ${cfg.pageLayout}`);
            }
        } catch (e) {
            console.warn("[NutrientAudit] could not apply viewer config", e);
        }
        this.appliedConfig = cfg;
    }

    /** Removes the download/print buttons when the maker disabled them. */
    private filterToolbar(items: any[], cfg: ViewerConfig): any[] {
        return items.filter((item) => {
            if (item.id === "audit-download") return cfg.allowDownload;
            if (item.id === "audit-print") return cfg.allowPrint;
            return true;
        });
    }

    private scheduleReload(url: string): void {
        if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
        this.reloadTimer = window.setTimeout(() => {
            const latest = this.resolveUrl();
            if (latest !== this.currentUrl) void this.loadDocument(latest);
        }, 900);
    }

    public getOutputs(): IOutputs {
        return {};
    }

    public destroy(): void {
        this.tracker?.close();
        if (this.tickTimer) window.clearInterval(this.tickTimer);
        document.removeEventListener("visibilitychange", this.onVisibility);
        window.removeEventListener("beforeunload", this.onUnload);
        if (this.instance && sdkWindow.NutrientViewer) {
            sdkWindow.NutrientViewer.unload(this.viewerHost);
            this.instance = undefined;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Viewer lifecycle                                                    */
    /* ------------------------------------------------------------------ */

    private resolveUrl(): string {
        const raw = this.context.parameters.documentUrl.raw;
        // The test harness seeds bound text properties with placeholder values,
        // so only accept real URLs and fall back to the demo document otherwise.
        return raw && /^https?:\/\//i.test(raw) ? raw : DEFAULT_DOCUMENT;
    }

    private resolveDocumentName(url: string): string {
        try {
            const path = new URL(url).pathname;
            return decodeURIComponent(path.substring(path.lastIndexOf("/") + 1)) || url;
        } catch {
            return url;
        }
    }

    private async loadDocument(url: string): Promise<void> {
        // Close the previous audit session before switching documents.
        this.tracker?.close();
        if (this.tickTimer) window.clearInterval(this.tickTimer);
        this.currentUrl = url;
        this.prevViewState = {};
        this.lastSaveStateDirty = false;

        const NutrientViewer = await this.loadSdk();
        if (this.instance) {
            NutrientViewer.unload(this.viewerHost);
            this.instance = undefined;
        }

        const user = this.resolveUser();
        const documentName = this.resolveDocumentName(url);
        this.tracker = new AuditTracker(
            { userId: user.id, userName: user.name, documentName, documentUrl: url },
            this.buildSinks(),
            (stats) => {
                this.latestStats = stats;
                this.renderStats(stats);
            }
        );

        const cfg = this.resolveConfig();
        this.instance = await NutrientViewer.load({
            container: this.viewerHost,
            document: url,
            licenseKey: LICENSE_KEY || undefined,
            theme: cfg.theme === "DARK" ? NutrientViewer.Theme.DARK : undefined,
        });

        this.instance.setToolbarItems((items: any[]) => {
            this.baseToolbarItems = this.instrumentToolbar(items);
            return this.filterToolbar(this.baseToolbarItems, cfg);
        });
        this.appliedConfig = undefined;
        this.applyViewConfig(true);
        this.instance.addEventListener("viewState.currentPageIndex.change", (pageIndex: number) =>
            this.tracker?.pageChanged(pageIndex)
        );
        this.wireViewerEvents();

        this.tracker.documentOpened(this.instance.totalPageCount);
        this.tickTimer = window.setInterval(() => {
            if (this.tracker) this.renderStats(this.tracker.stats());
        }, 1000);
    }

    /**
     * Subscribes to every auditable event the Nutrient Web SDK exposes.
     * Each subscription is wrapped in try/catch so an event name that does not
     * exist in the loaded SDK version simply degrades to "not tracked" instead
     * of breaking the control.
     */
    private wireViewerEvents(): void {
        const on = (name: string, handler: (...args: any[]) => void): boolean => {
            try {
                this.instance.addEventListener(name, handler);
                return true;
            } catch {
                console.info(`[NutrientAudit] event "${name}" not available in this SDK version`);
                return false;
            }
        };
        const track = (type: string, detail?: string, page?: number, payload?: string) =>
            this.tracker?.interaction(type, detail, page, payload);
        const annotationDetail = (list: any) => {
            const first = list?.first?.() ?? (Array.isArray(list) ? list[0] : undefined);
            const count = list?.size ?? list?.length ?? 1;
            return { detail: `${count} annotation${count > 1 ? "s" : ""}`, page: first?.pageIndex !== undefined ? first.pageIndex + 1 : undefined };
        };

        // Zoom (debounced: pinch/scroll zoom fires continuously)
        on("viewState.zoom.change", debounce(() => {
            const level = this.instance?.currentZoomLevel;
            track("ZoomChanged", typeof level === "number" ? `zoom ${Math.round(level * 100)}%` : undefined);
        }, 400));

        // View state: sidebar, layout, scroll and interaction mode switches
        on("viewState.change", (vs: any) => this.diffViewState(vs));

        // Annotations, with the full annotation object as expandable payload
        on("annotations.create", (a: any) => { const d = annotationDetail(a); track("AnnotationCreated", d.detail, d.page, this.serializeAnnotations(a)); });
        on("annotations.update", (a: any) => { const d = annotationDetail(a); track("AnnotationUpdated", d.detail, d.page, this.serializeAnnotations(a)); });
        on("annotations.delete", (a: any) => { const d = annotationDetail(a); track("AnnotationDeleted", d.detail, d.page, this.serializeAnnotations(a)); });
        on("annotationSelection.change", (annotation: any) => {
            if (annotation) track("AnnotationSelected", undefined, annotation.pageIndex !== undefined ? annotation.pageIndex + 1 : undefined);
        });

        // Comments and bookmarks
        on("comments.create", () => track("CommentAdded"));
        on("comments.update", () => track("CommentUpdated"));
        on("comments.delete", () => track("CommentDeleted"));
        on("bookmarks.create", () => track("BookmarkAdded"));
        on("bookmarks.update", () => track("BookmarkUpdated"));
        on("bookmarks.delete", () => track("BookmarkDeleted"));

        // Forms
        on("formFieldValues.update", (values: any) => {
            const first = values?.first?.();
            track("FormFieldChanged", first?.name ? `field "${first.name}"` : undefined);
        });
        on("forms.willSubmit", () => track("FormSubmitted"));

        // Signatures (inkSignatures is the pre-storedSignatures API; only used as fallback)
        if (!on("storedSignatures.create", () => track("SignatureAdded"))) {
            on("inkSignatures.create", () => track("SignatureAdded"));
        }

        // Search, with the term the user looked for
        on("search.stateChange", debounce((state: any) => {
            const term = state?.term?.trim?.();
            if (term) track("SearchPerformed", `"${term}" (${state?.results?.size ?? 0} hits)`);
        }, 700));

        // Text selection and clipboard copy
        on("textSelection.change", debounce((selection: any) => {
            if (!selection) return;
            const text = selection.getText?.();
            if (text && typeof text.then === "function") {
                void text.then((t: string) => {
                    const snippet = t?.trim();
                    if (snippet) track("TextSelected", `"${truncate(snippet, 80)}"`);
                    return undefined;
                });
            } else if (typeof text === "string" && text.trim()) {
                track("TextSelected", `"${truncate(text.trim(), 80)}"`);
            }
        }, 800));
        try {
            this.instance.contentDocument?.addEventListener("copy", () => track("TextCopied", "content copied to clipboard"));
        } catch {
            /* contentDocument not reachable in this hosting mode */
        }

        // Undo/redo and document modification state
        on("history.undo", () => track("ActionUndone"));
        on("history.redo", () => track("ActionRedone"));
        on("document.saveStateChange", (event: any) => {
            if (event?.hasUnsavedChanges && !this.lastSaveStateDirty) track("DocumentModified");
            this.lastSaveStateDirty = !!event?.hasUnsavedChanges;
        });
    }

    /**
     * Serializes annotations to their full InstantJSON representation (type,
     * page, bounding box, colors, author, timestamps, ...), used as the
     * "parameters" payload on annotation audit events.
     */
    private serializeAnnotations(list: any): string | undefined {
        try {
            const NutrientViewer = sdkWindow.NutrientViewer;
            const items: any[] = list?.toArray?.() ?? (Array.isArray(list) ? list : [list]);
            const serialized = items.map((annotation) => {
                const obj = NutrientViewer?.Annotations?.toSerializableObject?.(annotation) ?? annotation?.toJS?.() ?? null;
                if (obj) {
                    // Enrich with identity fields that are useful for an audit trail.
                    obj.id = obj.id ?? annotation?.id;
                    obj.creatorName = obj.creatorName ?? annotation?.creatorName;
                    obj.createdAt = obj.createdAt ?? annotation?.createdAt?.toISOString?.();
                    obj.updatedAt = obj.updatedAt ?? annotation?.updatedAt?.toISOString?.();
                }
                return obj;
            }).filter(Boolean);
            if (serialized.length === 0) return undefined;
            return JSON.stringify(serialized.length === 1 ? serialized[0] : serialized, null, 2);
        } catch {
            return undefined;
        }
    }

    /** Logs sidebar/layout/scroll/interaction mode switches from viewState.change. */
    private diffViewState(vs: any): void {
        const watched: [string, string][] = [
            ["sidebarMode", "SidebarChanged"],
            ["layoutMode", "LayoutChanged"],
            ["scrollMode", "ScrollModeChanged"],
            ["interactionMode", "InteractionModeChanged"],
        ];
        for (const [key, type] of watched) {
            const value = vs?.[key] ?? null;
            if (this.prevViewState[key] !== undefined && this.prevViewState[key] !== value && value !== null) {
                this.tracker?.interaction(type, String(value));
            }
            this.prevViewState[key] = value;
        }
    }

    private loadSdk(): Promise<any> {
        if (sdkWindow.NutrientViewer) return Promise.resolve(sdkWindow.NutrientViewer);
        return new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = SDK_URL;
            script.onload = () => resolve(sdkWindow.NutrientViewer);
            script.onerror = () => reject(new Error("Failed to load the Nutrient Web SDK from CDN"));
            document.head.appendChild(script);
        });
    }

    /**
     * Replaces the stock download and print toolbar buttons with instrumented
     * equivalents, so both actions are captured in the audit trail before the
     * user-facing behavior runs.
     */
    private instrumentToolbar(items: any[]): any[] {
        return items.map((item) => {
            if (item.type === "export-pdf") {
                return {
                    type: "custom",
                    id: "audit-download",
                    title: "Download",
                    icon: ICON_DOWNLOAD,
                    onPress: () => void this.downloadDocument(),
                };
            }
            if (item.type === "print") {
                return {
                    type: "custom",
                    id: "audit-print",
                    title: "Print",
                    icon: ICON_PRINT,
                    onPress: () => {
                        this.tracker?.documentPrinted();
                        this.instance.print();
                    },
                };
            }
            return item;
        });
    }

    private async downloadDocument(): Promise<void> {
        this.tracker?.documentDownloaded();
        const buffer: ArrayBuffer = await this.instance.exportPDF();
        const blob = new Blob([buffer], { type: "application/pdf" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = this.resolveDocumentName(this.currentUrl);
        link.click();
        URL.revokeObjectURL(link.href);
    }

    /* ------------------------------------------------------------------ */
    /* Audit wiring                                                        */
    /* ------------------------------------------------------------------ */

    private resolveUser(): { id: string; name: string } {
        const settings = this.context.userSettings;
        const id = settings?.userId?.replace(/[{}]/g, "") ?? "";
        const name = settings?.userName || "Harness User";
        return { id: id || "00000000-0000-0000-0000-000000000000", name };
    }

    /** True when running inside Dataverse (model-driven or canvas app), false in the local test harness. */
    private isDataverseHost(): boolean {
        const id = this.context.userSettings?.userId?.replace(/[{}0-]/g, "");
        return !!id;
    }

    private buildSinks() {
        this.auditLog = [];
        const sinks = [createConsoleSink(), this.createPanelSink(), (e: AuditEvent) => this.auditLog.push(e)];
        this.dataverseConnected = this.isDataverseHost();
        if (this.dataverseConnected) {
            sinks.push(
                createDataverseSink(this.context.webAPI, AUDIT_TABLE, (ok, info) => this.markLastEvent(ok, info))
            );
        }
        this.renderMode();
        return sinks;
    }

    /* ------------------------------------------------------------------ */
    /* Audit panel UI                                                      */
    /* ------------------------------------------------------------------ */

    private buildPanel(): HTMLElement {
        const panel = document.createElement("aside");
        panel.className = "audit-panel";
        panel.innerHTML = `
            <header class="audit-panel-header">
                <h2>Document Audit Trail</h2>
                <span class="audit-mode"></span>
                <div class="audit-actions">
                    <button type="button" class="audit-btn audit-export" title="Download the full audit log of this session as JSON (the exact payload sent to Dataverse)">Export JSON</button>
                    <button type="button" class="audit-btn audit-reset" title="Close the current audit session (emits DocumentClosed + SessionSummary) and start a fresh one">New session</button>
                </div>
            </header>
            <section class="audit-stats"></section>
            <section class="audit-section">
                <h3>Time per page</h3>
                <div class="audit-pagebars"></div>
            </section>
            <section class="audit-section audit-log-section">
                <h3>Audit events</h3>
                <div class="audit-log"></div>
            </section>`;
        this.panel = {
            mode: panel.querySelector(".audit-mode") as HTMLElement,
            stats: panel.querySelector(".audit-stats") as HTMLElement,
            pageBars: panel.querySelector(".audit-pagebars") as HTMLElement,
            log: panel.querySelector(".audit-log") as HTMLElement,
        };
        (panel.querySelector(".audit-export") as HTMLButtonElement).onclick = () => this.exportAuditLog();
        (panel.querySelector(".audit-reset") as HTMLButtonElement).onclick = () => void this.loadDocument(this.currentUrl);
        // Clicking a time-per-page bar jumps the viewer to that page.
        this.panel.pageBars.onclick = (e) => {
            const row = (e.target as HTMLElement).closest?.("[data-page]") as HTMLElement | null;
            if (row?.dataset.page) this.goToPage(Number(row.dataset.page));
        };
        // Clicking an event row jumps to the page the event happened on.
        this.panel.log.onclick = (e) => {
            const target = e.target as HTMLElement;
            if (target.closest?.(".audit-params")) return; // let the parameters dropdown toggle
            const row = target.closest?.("[data-page]") as HTMLElement | null;
            if (row?.dataset.page) this.goToPage(Number(row.dataset.page));
        };
        return panel;
    }

    /** Jumps the viewer to a 1-based page number. */
    private goToPage(page: number): void {
        try {
            this.instance?.setViewState((vs: any) => vs.set("currentPageIndex", page - 1));
        } catch {
            /* viewer not ready */
        }
    }

    /** Downloads the audit log of the current session as a JSON file. */
    private exportAuditLog(): void {
        const stats = this.tracker?.stats();
        const payload = {
            exportedAt: new Date().toISOString(),
            sessionStats: stats,
            events: this.auditLog,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `audit-trail-${stats?.sessionId ?? "session"}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
    }

    private renderMode(): void {
        this.panel.mode.textContent = this.dataverseConnected
            ? `Dataverse: ${AUDIT_TABLE}`
            : "Harness mode: Dataverse writes simulated";
        this.panel.mode.classList.toggle("connected", this.dataverseConnected);
    }

    private createPanelSink() {
        return (event: AuditEvent) => {
            const row = document.createElement("div");
            row.className = "audit-log-row";
            if (event.pageNumber) {
                row.dataset.page = String(event.pageNumber);
                row.classList.add("audit-clickable");
                row.title = `Go to page ${event.pageNumber}`;
            }
            const time = new Date(event.timestamp).toLocaleTimeString();
            const page = event.pageNumber ? ` p.${event.pageNumber}` : "";
            const duration = event.durationSeconds !== undefined ? ` (${event.durationSeconds}s)` : "";
            const detail = event.detail && event.eventType !== "SessionSummary" ? ` ${escapeHtml(truncate(event.detail, 60))}` : "";
            row.innerHTML = `
                <span class="audit-log-time">${time}</span>
                <span class="audit-log-type audit-ev-${event.eventType}">${event.eventType}</span>
                <span class="audit-log-detail">${page}${duration}${detail}</span>
                <span class="audit-log-status">${this.dataverseConnected ? "..." : "local"}</span>`;
            if (event.payload) {
                const params = document.createElement("details");
                params.className = "audit-params";
                const pre = document.createElement("pre");
                pre.textContent = event.payload;
                const summary = document.createElement("summary");
                summary.textContent = "parameters";
                params.appendChild(summary);
                params.appendChild(pre);
                row.appendChild(params);
            }
            this.panel.log.prepend(row);
            while (this.panel.log.childElementCount > 60) this.panel.log.lastElementChild?.remove();
        };
    }

    private markLastEvent(ok: boolean, info: string): void {
        const pending = Array.from(this.panel.log.querySelectorAll(".audit-log-status")).find(
            (el) => el.textContent === "..."
        );
        if (pending) {
            pending.textContent = ok ? "stored" : "failed";
            pending.classList.add(ok ? "ok" : "err");
            (pending as HTMLElement).title = info;
        }
    }

    private renderStats(stats: SessionStats): void {
        const pct = Math.round(stats.readProgress * 100);
        this.panel.stats.innerHTML = `
            <div class="audit-stat"><label>Viewer</label><b>${escapeHtml(stats.userName)}</b></div>
            <div class="audit-stat"><label>Document</label><b title="${escapeHtml(stats.documentName)}">${escapeHtml(stats.documentName)}</b></div>
            <div class="audit-stat"><label>Session time</label><b>${formatDuration(stats.totalSeconds)}</b></div>
            <div class="audit-stat"><label>Current page</label><b>${stats.currentPage} / ${stats.pageCount}</b></div>
            <div class="audit-stat"><label>Pages viewed</label><b>${stats.pagesViewed.length} of ${stats.pageCount}</b></div>
            <div class="audit-stat"><label>Last page viewed</label><b>${stats.lastPageViewed}</b></div>
            <div class="audit-stat"><label>Downloads / Prints</label><b>${stats.downloads} / ${stats.prints}</b></div>
            <div class="audit-stat audit-progress">
                <label>Read progress</label>
                <div class="audit-progress-track"><div class="audit-progress-fill" style="width:${pct}%"></div></div>
                <b>${pct}%</b>
            </div>
            ${this.renderCounters(stats)}`;
        this.renderPageBars(stats);
    }

    /** One chip per interaction type (ZoomChanged x3, SearchPerformed x1, ...). */
    private renderCounters(stats: SessionStats): string {
        const entries = Object.entries(stats.counters);
        if (entries.length === 0) return "";
        const chips = entries
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => `<span class="audit-chip"><i class="audit-ev-${type}">${type}</i> x${count}</span>`)
            .join("");
        return `<div class="audit-stat audit-chipwrap"><label>Interactions</label><div class="audit-chips">${chips}</div></div>`;
    }

    private renderPageBars(stats: SessionStats): void {
        const entries = Object.entries(stats.timePerPage);
        if (entries.length === 0) {
            this.panel.pageBars.innerHTML = "<span class='audit-empty'>No page activity yet</span>";
            return;
        }
        const max = Math.max(...entries.map(([, s]) => s), 1);
        this.panel.pageBars.innerHTML = entries
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(
                ([page, secs]) => `
                <div class="audit-bar-row audit-clickable" data-page="${page}" title="Go to page ${page}">
                    <span class="audit-bar-label">p.${page}</span>
                    <div class="audit-bar-track"><div class="audit-bar-fill" style="width:${Math.max(3, (secs / max) * 100)}%"></div></div>
                    <span class="audit-bar-secs">${formatDuration(secs)}</span>
                </div>`
            )
            .join("");
    }

    private applySize(): void {
        const h = this.context.mode.allocatedHeight;
        this.root.style.height = h && h > 0 ? `${h}px` : "740px";
    }
}

function formatDuration(totalSeconds: number): string {
    if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
    const m = Math.floor(totalSeconds / 60);
    const s = Math.round(totalSeconds % 60);
    return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function debounce<T extends (...args: any[]) => void>(fn: T, waitMs: number): T {
    let timer: number | undefined;
    return ((...args: any[]) => {
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => fn(...args), waitMs);
    }) as T;
}

function truncate(value: string, max: number): string {
    return value.length > max ? value.slice(0, max) + "..." : value;
}

function escapeHtml(value: string): string {
    const div = document.createElement("div");
    div.textContent = value;
    return div.innerHTML;
}
