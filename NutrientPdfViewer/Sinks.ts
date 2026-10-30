import { AuditEvent, AuditSink } from "./AuditTracker";

/**
 * Persists audit events to Dataverse through the PCF Web API.
 * One row per event in the audit table (default demo_documentauditevent).
 */
export function createDataverseSink(
    webApi: ComponentFramework.WebApi,
    tableLogicalName: string,
    onResult: (ok: boolean, info: string) => void
): AuditSink {
    return (event: AuditEvent) => {
        const record: ComponentFramework.WebApi.Entity = {
            demo_name: `${event.eventType}${event.pageNumber ? " p" + event.pageNumber : ""} by ${event.userName}`,
            demo_sessionid: event.sessionId,
            demo_eventtype: event.eventType,
            demo_userid: event.userId,
            demo_username: event.userName,
            demo_documentname: event.documentName,
            demo_documenturl: event.documentUrl,
            demo_pagenumber: event.pageNumber ?? null,
            demo_pagecount: event.pageCount ?? null,
            demo_durationseconds: event.durationSeconds ?? null,
            demo_detail: event.payload ?? event.detail ?? null,
            demo_eventtimestamp: event.timestamp,
        };
        webApi
            .createRecord(tableLogicalName, record)
            .then((ref) => onResult(true, `Dataverse row ${ref.id.slice(0, 8)}`))
            .catch((err: Error) => onResult(false, `Dataverse write failed: ${err.message}`));
    };
}

/** Mirrors every audit event to the browser console (useful in the PCF test harness). */
export function createConsoleSink(): AuditSink {
    return (event: AuditEvent) => {
        console.info(`[NutrientAudit] ${event.eventType}`, event);
    };
}
