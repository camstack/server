/**
 * The event-category catalogue: what an operator-facing surface (a picker, the
 * Logs → Events section, the automation `device-event` row) needs to know about
 * each {@link EventCategory}.
 *
 * `EVENT_CATEGORY_CATALOG` is a `Record<EventCategory, …>`, so it is TOTAL over
 * the enum: a category without an entry here does not compile. That is the
 * whole point — a new category cannot ship unlabelled, ungrouped and unclassified
 * as noise. The kernel's ring-buffer deny list is derived from `noise`, so the
 * broker's "do not retain" set cannot drift from the catalogue.
 *
 * Descriptions are not catalogued yet; a label is the shortest thing a picker
 * can show next to the raw id.
 */
import { EventCategory, isOwnerOnlyEventCategory } from './event-category.js'

export type EventCategoryGroup =
  | 'system'
  | 'addons'
  | 'devices'
  | 'integrations'
  | 'recording'
  | 'storage'
  | 'detection'
  | 'pipeline'
  | 'enrichment'
  | 'streams'
  | 'network'
  | 'agents'
  | 'notifications'
  | 'backup'
  | 'metrics'

/** Display order of the groups in a picker. */
export const EVENT_CATEGORY_GROUPS: readonly EventCategoryGroup[] = [
  'devices',
  'detection',
  'recording',
  'storage',
  'streams',
  'pipeline',
  'enrichment',
  'notifications',
  'integrations',
  'addons',
  'agents',
  'network',
  'backup',
  'system',
  'metrics',
]

export interface EventCategoryLabel {
  readonly en: string
  readonly it: string
}

export interface EventCategoryEntry {
  readonly group: EventCategoryGroup
  readonly label: EventCategoryLabel
  /** High-frequency telemetry: hidden from live views by default and never retained in the event ring. */
  readonly noise: boolean
  /** Superseded by another category; still emitted or kept as an alias, never offered for new use. */
  readonly deprecated: boolean
}

interface EntryFlags {
  readonly noise?: true
  readonly deprecated?: true
}

function e(
  group: EventCategoryGroup,
  en: string,
  it: string,
  flags: EntryFlags = {},
): EventCategoryEntry {
  return {
    group,
    label: { en, it },
    noise: flags.noise === true,
    deprecated: flags.deprecated === true,
  }
}

const N: EntryFlags = { noise: true }

export const EVENT_CATEGORY_CATALOG: Readonly<Record<EventCategory, EventCategoryEntry>> = {
  [EventCategory.SystemBoot]: e('system', 'System booted', 'Sistema avviato'),
  [EventCategory.SystemAddonsReady]: e('system', 'Addons ready', 'Addon pronti'),
  [EventCategory.SystemRestarting]: e('system', 'System restarting', 'Sistema in riavvio'),
  [EventCategory.SystemRestartCompleted]: e('system', 'Restart completed', 'Riavvio completato'),
  [EventCategory.SystemTlsCertChanged]: e(
    'system',
    'TLS certificate changed',
    'Certificato TLS cambiato',
  ),
  [EventCategory.UpdateAvailable]: e('system', 'Update available', 'Aggiornamento disponibile'),
  [EventCategory.SystemReadyState]: e('system', 'Readiness changed', 'Stato di prontezza cambiato'),
  [EventCategory.AddonStarted]: e('addons', 'Addon started', 'Addon avviato'),
  [EventCategory.AddonStopped]: e('addons', 'Addon stopped', 'Addon fermato'),
  [EventCategory.AddonRestarted]: e('addons', 'Addon restarted', 'Addon riavviato'),
  [EventCategory.AddonUpdated]: e('addons', 'Addon updated', 'Addon aggiornato'),
  [EventCategory.AddonInstalled]: e('addons', 'Addon installed', 'Addon installato'),
  [EventCategory.AddonUninstalled]: e('addons', 'Addon uninstalled', 'Addon disinstallato'),
  [EventCategory.AddonCrashed]: e('addons', 'Addon crashed', 'Addon in errore fatale'),
  [EventCategory.AddonRunnerFailed]: e(
    'addons',
    'Runner failed for good',
    'Runner fallito definitivamente',
  ),
  [EventCategory.AddonRunnerRefused]: e('addons', 'Runner refused', 'Runner rifiutato'),
  [EventCategory.ProcessStateChanged]: e(
    'addons',
    'Process state changed',
    'Stato del processo cambiato',
  ),
  [EventCategory.SystemRunnerCheck]: e('system', 'Runner check', 'Verifica dei runner'),
  [EventCategory.AlertEpisode]: e('system', 'Alert episode', 'Episodio di allarme'),
  [EventCategory.AddonError]: e('addons', 'Addon error', 'Errore di un addon'),
  [EventCategory.AddonPageReady]: e('addons', 'Addon page ready', 'Pagina addon pronta'),
  [EventCategory.AddonWidgetReady]: e('addons', 'Addon widget ready', 'Widget addon pronto'),
  [EventCategory.AddonLoadFailed]: e('addons', 'Addon failed to load', 'Caricamento addon fallito'),
  [EventCategory.KeychainChanged]: e('system', 'Keychain changed', 'Portachiavi modificato'),
  [EventCategory.AddonLoadRecovered]: e(
    'addons',
    'Addon load recovered',
    'Caricamento addon ripristinato',
  ),
  [EventCategory.AddonUnsupportedVersion]: e(
    'addons',
    'Addon version unsupported',
    'Versione addon non supportata',
  ),
  [EventCategory.AddonUnsupportedResolved]: e(
    'addons',
    'Unsupported addon resolved',
    'Addon non supportato risolto',
  ),
  [EventCategory.AddonRetryScheduled]: e(
    'addons',
    'Addon retry scheduled',
    'Nuovo tentativo addon pianificato',
  ),
  [EventCategory.SystemLivenessFailed]: e(
    'system',
    'Liveness check failed',
    'Controllo di attività fallito',
  ),
  [EventCategory.SystemLivenessRecovered]: e(
    'system',
    'Liveness recovered',
    'Controllo di attività ripristinato',
  ),
  [EventCategory.AddonRetryAttempting]: e(
    'addons',
    'Addon retry running',
    'Nuovo tentativo addon in corso',
  ),
  [EventCategory.DeviceRegistered]: e('devices', 'Device registered', 'Dispositivo registrato'),
  [EventCategory.DeviceUnregistered]: e('devices', 'Device removed', 'Dispositivo rimosso'),
  [EventCategory.DeviceEnabled]: e('devices', 'Device enabled', 'Dispositivo abilitato'),
  [EventCategory.DeviceDisabled]: e('devices', 'Device disabled', 'Dispositivo disabilitato'),
  [EventCategory.DeviceSettingsUpdated]: e(
    'devices',
    'Device settings updated',
    'Impostazioni dispositivo aggiornate',
  ),
  [EventCategory.DeviceBindingsChanged]: e(
    'devices',
    'Device bindings changed',
    'Collegamenti dispositivo cambiati',
  ),
  [EventCategory.DeviceMetaChanged]: e(
    'devices',
    'Device details changed',
    'Dettagli dispositivo cambiati',
  ),
  [EventCategory.DeviceSourceInfoChanged]: e(
    'devices',
    'Device source info changed',
    'Info sorgente dispositivo cambiate',
  ),
  [EventCategory.DeviceStreamsRegistered]: e(
    'streams',
    'Device streams registered',
    'Stream del dispositivo registrati',
  ),
  [EventCategory.DeviceProvisioned]: e('devices', 'Device provisioned', 'Dispositivo configurato'),
  [EventCategory.DeviceReady]: e('devices', 'Device ready', 'Dispositivo pronto'),
  [EventCategory.IdentityLinkCreated]: e('integrations', 'Identity linked', 'Identità collegata'),
  [EventCategory.IdentityLinkLost]: e(
    'integrations',
    'Identity link lost',
    'Collegamento identità perso',
  ),
  [EventCategory.IntegrationEnabled]: e(
    'integrations',
    'Integration enabled',
    'Integrazione abilitata',
  ),
  [EventCategory.IntegrationDisabled]: e(
    'integrations',
    'Integration disabled',
    'Integrazione disabilitata',
  ),
  [EventCategory.IntegrationDeleted]: e(
    'integrations',
    'Integration deleted',
    'Integrazione eliminata',
  ),
  [EventCategory.BrokerStatusChanged]: e(
    'integrations',
    'Broker status changed',
    'Stato del broker cambiato',
  ),
  [EventCategory.BrokerMessage]: e('integrations', 'Broker message', 'Messaggio del broker', N),
  [EventCategory.ProviderStarted]: e('integrations', 'Provider started', 'Provider avviato'),
  [EventCategory.ProviderStopped]: e('integrations', 'Provider stopped', 'Provider fermato'),
  [EventCategory.ProcessCrashed]: e('addons', 'Process crashed', 'Processo andato in crash'),
  [EventCategory.ProcessRestartScheduled]: e(
    'addons',
    'Process restart scheduled',
    'Riavvio del processo pianificato',
  ),
  [EventCategory.ProcessRestarted]: e('addons', 'Process restarted', 'Processo riavviato'),
  [EventCategory.StorageLocationsChanged]: e(
    'storage',
    'Storage locations changed',
    'Posizioni di archiviazione cambiate',
  ),
  [EventCategory.RecordingStarted]: e('recording', 'Recording started', 'Registrazione avviata'),
  [EventCategory.RecordingStopped]: e('recording', 'Recording stopped', 'Registrazione fermata'),
  [EventCategory.RecordingError]: e('recording', 'Recording error', 'Errore di registrazione'),
  [EventCategory.RecordingHealthDegraded]: e(
    'recording',
    'Recording degraded',
    'Registrazione degradata',
  ),
  [EventCategory.RecordingHealthStalled]: e(
    'recording',
    'Recording stalled',
    'Registrazione bloccata',
  ),
  [EventCategory.RecordingHealthOk]: e('recording', 'Recording healthy', 'Registrazione regolare'),
  [EventCategory.RecordingStorageCritical]: e(
    'recording',
    'Recording storage critical',
    'Spazio di registrazione critico',
  ),
  [EventCategory.StorageLocationLow]: e('storage', 'Storage location low', 'Spazio in esaurimento'),
  [EventCategory.StorageLocationCritical]: e(
    'storage',
    'Storage location critical',
    'Spazio critico',
  ),
  [EventCategory.StorageLocationOk]: e(
    'storage',
    'Storage location recovered',
    'Spazio tornato regolare',
  ),
  [EventCategory.StorageDrainProgress]: e(
    'storage',
    'Drain progress',
    'Avanzamento dello svuotamento',
  ),
  [EventCategory.StorageDrainComplete]: e('storage', 'Drain complete', 'Svuotamento completato'),
  [EventCategory.RecordingSegmentWritten]: e('recording', 'Segment written', 'Segmento scritto'),
  [EventCategory.RecordingPolicyFallback]: e(
    'recording',
    'Recording policy fallback',
    'Politica di registrazione di ripiego',
  ),
  [EventCategory.RecordingRetentionCompleted]: e(
    'recording',
    'Retention completed',
    'Pulizia completata',
  ),
  [EventCategory.RecordingExportProgress]: e(
    'recording',
    'Export progress',
    'Avanzamento esportazione',
  ),
  [EventCategory.RecordingExportCompleted]: e(
    'recording',
    'Export completed',
    'Esportazione completata',
  ),
  [EventCategory.RecordingExportFailed]: e('recording', 'Export failed', 'Esportazione fallita'),
  [EventCategory.DetectionEvent]: e('detection', 'Detection', 'Rilevamento'),
  [EventCategory.SessionTrackNew]: e(
    'detection',
    'Session track started',
    'Nuova traccia di sessione',
  ),
  [EventCategory.SessionTrackExpired]: e(
    'detection',
    'Session track expired',
    'Traccia di sessione scaduta',
  ),
  [EventCategory.BenchmarkProgress]: e('metrics', 'Benchmark progress', 'Avanzamento benchmark', N),
  [EventCategory.PlatformProbePhase]: e(
    'metrics',
    'Platform probe phase',
    'Fase di analisi piattaforma',
    N,
  ),
  [EventCategory.PipelineProgress]: e('pipeline', 'Pipeline progress', 'Avanzamento pipeline', N),
  [EventCategory.PipelineTrace]: e('pipeline', 'Pipeline trace', 'Traccia pipeline', N),
  [EventCategory.PipelineInferenceResult]: e(
    'pipeline',
    'Inference result',
    'Risultato di inferenza',
    N,
  ),
  [EventCategory.PipelineCameraAssigned]: e(
    'pipeline',
    'Camera assigned to pipeline',
    'Camera assegnata alla pipeline',
  ),
  [EventCategory.PipelineCameraUnassigned]: e(
    'pipeline',
    'Camera unassigned from pipeline',
    'Camera rimossa dalla pipeline',
  ),
  [EventCategory.PipelineNodeInferenceUnavailable]: e(
    'pipeline',
    'Node inference unavailable',
    'Inferenza del nodo non disponibile',
  ),
  [EventCategory.PipelineDetectionBlind]: e('pipeline', 'Detection blind', 'Rilevamento cieco'),
  [EventCategory.PipelineMotionNoisy]: e(
    'pipeline',
    'Motion too noisy',
    'Movimento troppo disturbato',
  ),
  [EventCategory.PipelineMotionCalm]: e(
    'pipeline',
    'Motion calm again',
    'Movimento di nuovo calmo',
  ),
  [EventCategory.PipelinePackageLlmSilent]: e(
    'pipeline',
    'Package check silent',
    'Verifica pacchi senza risposta',
  ),
  [EventCategory.PipelinePackageLlmAnswered]: e(
    'pipeline',
    'Package check answered',
    'Verifica pacchi con risposta',
  ),
  [EventCategory.PipelineCameraUpdated]: e(
    'pipeline',
    'Pipeline camera updated',
    'Camera della pipeline aggiornata',
  ),
  [EventCategory.PipelineIngestOwnerChanged]: e(
    'pipeline',
    'Ingest owner changed',
    'Responsabile dell’acquisizione cambiato',
  ),
  [EventCategory.PipelineRunnerLoadSnapshot]: e(
    'metrics',
    'Runner load snapshot',
    'Carico dei runner',
    N,
  ),
  [EventCategory.PipelineCameraMetricsSnapshot]: e(
    'metrics',
    'Camera metrics snapshot',
    'Metriche delle camere',
    N,
  ),
  [EventCategory.StreamBrokerMetricsSnapshot]: e(
    'metrics',
    'Stream broker metrics',
    'Metriche dello stream broker',
    N,
  ),
  [EventCategory.StreamBrokerOnCamStreamDemand]: e(
    'streams',
    'Stream requested',
    'Stream richiesto',
  ),
  [EventCategory.StreamBrokerOnCamStreamIdle]: e('streams', 'Stream idle', 'Stream inattivo'),
  [EventCategory.StreamBrokerOnRequestStreamSourceRefresh]: e(
    'streams',
    'Stream source refresh requested',
    'Aggiornamento sorgente stream richiesto',
  ),
  [EventCategory.StreamBrokerOnSourceRestart]: e(
    'streams',
    'Stream source restarted',
    'Sorgente stream riavviata',
  ),
  [EventCategory.StreamParamsChanged]: e(
    'streams',
    'Stream parameters changed',
    'Parametri dello stream cambiati',
  ),
  [EventCategory.DeviceStateChanged]: e(
    'devices',
    'Device state changed',
    'Stato dispositivo cambiato',
  ),
  [EventCategory.DeviceCommandSettled]: e(
    'devices',
    'Device command settled',
    'Comando al dispositivo concluso',
  ),
  [EventCategory.DeviceNativeShadowChanged]: e(
    'devices',
    'Device native state changed',
    'Stato nativo del dispositivo cambiato',
  ),
  [EventCategory.ZoneAnalyticsOccupancyChanged]: e(
    'detection',
    'Zone occupancy changed',
    'Occupazione zona cambiata',
  ),
  [EventCategory.BatteryOnStatusChanged]: e(
    'devices',
    'Battery status changed',
    'Stato batteria cambiato',
  ),
  [EventCategory.NetworkLinkOnStatusChanged]: e(
    'devices',
    'Network link status changed',
    'Stato del collegamento di rete cambiato',
  ),
  [EventCategory.BatteryOnWakeStarted]: e(
    'devices',
    'Battery device woke up',
    'Dispositivo a batteria attivato',
  ),
  [EventCategory.DoorbellOnPressed]: e('devices', 'Doorbell pressed', 'Campanello premuto'),
  [EventCategory.RunningStarted]: e('devices', 'Run started', 'Esecuzione avviata'),
  [EventCategory.RunningFinished]: e('devices', 'Run finished', 'Esecuzione terminata'),
  [EventCategory.WorkloadStarted]: e('devices', 'Workload started', 'Carico di lavoro avviato'),
  [EventCategory.WorkloadStopped]: e('devices', 'Workload stopped', 'Carico di lavoro fermato'),
  [EventCategory.WorkloadCrashed]: e('devices', 'Workload crashed', 'Carico di lavoro in crash'),
  [EventCategory.WorkloadRecovered]: e(
    'devices',
    'Workload recovered',
    'Carico di lavoro ripristinato',
  ),
  [EventCategory.DeviceRunOpened]: e(
    'devices',
    'Device run opened',
    'Ciclo del dispositivo aperto',
  ),
  [EventCategory.DeviceRunClosed]: e(
    'devices',
    'Device run closed',
    'Ciclo del dispositivo chiuso',
  ),
  [EventCategory.EventEmitted]: e('devices', 'Device event', 'Evento del dispositivo'),
  [EventCategory.PipelineEngineMetricsSnapshot]: e(
    'metrics',
    'Engine metrics snapshot',
    'Metriche dei motori',
    N,
  ),
  [EventCategory.PipelineEngineProvisioning]: e(
    'pipeline',
    'Engine provisioning',
    'Preparazione del motore',
  ),
  [EventCategory.ClusterTopologySnapshot]: e(
    'metrics',
    'Cluster topology snapshot',
    'Topologia del cluster',
    N,
  ),
  [EventCategory.MetricsNodeResourcesSnapshot]: e(
    'metrics',
    'Node resources snapshot',
    'Risorse dei nodi',
    N,
  ),
  [EventCategory.MetricsNodeProcessesSnapshot]: e(
    'metrics',
    'Node processes snapshot',
    'Processi dei nodi',
    N,
  ),
  [EventCategory.CapabilityBindingChanged]: e(
    'system',
    'Capability binding changed',
    'Collegamento di capability cambiato',
    N,
  ),
  [EventCategory.ModelDownloadProgress]: e(
    'pipeline',
    'Model download progress',
    'Avanzamento download modello',
    N,
  ),
  [EventCategory.AgentRegistered]: e('agents', 'Agent registered', 'Agent registrato'),
  [EventCategory.AgentUnregistered]: e('agents', 'Agent removed', 'Agent rimosso'),
  [EventCategory.AgentOnline]: e('agents', 'Agent online', 'Agent online'),
  [EventCategory.AgentOffline]: e('agents', 'Agent offline', 'Agent offline'),
  [EventCategory.WorkerOnline]: e('agents', 'Worker online', 'Worker online'),
  [EventCategory.WorkerOffline]: e('agents', 'Worker offline', 'Worker offline'),
  [EventCategory.AgentTaskDispatched]: e(
    'agents',
    'Agent task dispatched',
    'Attività inviata a un agent',
  ),
  [EventCategory.AgentTaskAssigned]: e(
    'agents',
    'Agent task assigned',
    'Attività assegnata a un agent',
  ),
  [EventCategory.AgentTrpcConnected]: e('agents', 'Agent API connected', 'API dell’agent connessa'),
  [EventCategory.AgentWsConnected]: e(
    'agents',
    'Agent socket connected',
    'Socket dell’agent connesso',
  ),
  [EventCategory.AgentWsDisconnected]: e(
    'agents',
    'Agent socket disconnected',
    'Socket dell’agent disconnesso',
  ),
  [EventCategory.AgentBackupActivated]: e(
    'agents',
    'Agent backup activated',
    'Backup dell’agent attivato',
  ),
  [EventCategory.OrchestrationSettingsUpdated]: e(
    'pipeline',
    'Orchestration settings updated',
    'Impostazioni di orchestrazione aggiornate',
  ),
  [EventCategory.MotionAnalysis]: e('detection', 'Motion analysis', 'Analisi del movimento', N),
  [EventCategory.MotionZonesRaw]: e('detection', 'Raw motion zones', 'Zone di movimento grezze', N),
  [EventCategory.MotionOnMotionChanged]: e('detection', 'Motion changed', 'Movimento cambiato', N),
  [EventCategory.DetectionResult]: e(
    'detection',
    'Detection result',
    'Risultato del rilevamento',
    N,
  ),
  [EventCategory.DetectionRaw]: e('detection', 'Raw detection', 'Rilevamento grezzo'),
  [EventCategory.DetectionCameraNative]: e(
    'detection',
    'Camera native detection',
    'Rilevamento nativo della camera',
  ),
  [EventCategory.PipelineAudioInferenceResult]: e(
    'pipeline',
    'Audio inference result',
    'Risultato di inferenza audio',
    N,
  ),
  [EventCategory.DetectionPhaseTransition]: e(
    'detection',
    'Detection phase changed',
    'Fase di rilevamento cambiata',
  ),
  [EventCategory.ProviderMotion]: e(
    'detection',
    'Camera raw motion',
    'Movimento grezzo della camera',
    N,
  ),
  [EventCategory.ProviderDetection]: e(
    'detection',
    'Camera onboard detection',
    'Rilevamento a bordo camera',
  ),
  [EventCategory.EnrichmentEmbeddingStored]: e(
    'enrichment',
    'Embedding stored',
    'Embedding salvato',
  ),
  [EventCategory.EnrichmentSceneStateChanged]: e(
    'enrichment',
    'Scene state changed',
    'Stato della scena cambiato',
  ),
  [EventCategory.EnrichmentActivitySummary]: e(
    'enrichment',
    'Activity summary',
    'Riepilogo dell’attività',
  ),
  [EventCategory.PipelineAnalyticsTrackLifecycle]: e(
    'detection',
    'Track lifecycle',
    'Ciclo di vita della traccia',
  ),
  [EventCategory.PipelineAnalyticsTrackStarted]: e(
    'detection',
    'Track started',
    'Traccia iniziata',
    {
      noise: true,
      deprecated: true,
    },
  ),
  [EventCategory.PipelineAnalyticsTrackEnded]: e('detection', 'Track ended', 'Traccia terminata', {
    noise: true,
    deprecated: true,
  }),
  [EventCategory.PipelineAnalyticsDetectionEvent]: e(
    'detection',
    'Analytics detection',
    'Rilevamento analitico',
    N,
  ),
  [EventCategory.PipelineAnalyticsFrameTracked]: e(
    'detection',
    'Frame tracked',
    'Fotogramma tracciato',
    N,
  ),
  [EventCategory.PipelineAnalyticsStationaryChanged]: e(
    'detection',
    'Stationary object changed',
    'Oggetto fermo cambiato',
  ),
  [EventCategory.PipelineAnalyticsPackageDelivered]: e(
    'detection',
    'Package delivered',
    'Pacco consegnato',
  ),
  [EventCategory.PipelineAnalyticsPackagePickedUp]: e(
    'detection',
    'Package picked up',
    'Pacco ritirato',
  ),
  [EventCategory.PipelineAnalyticsFaceGalleryChanged]: e(
    'enrichment',
    'Face gallery changed',
    'Galleria volti cambiata',
  ),
  [EventCategory.PipelineAnalyticsPlateGalleryChanged]: e(
    'enrichment',
    'Plate gallery changed',
    'Galleria targhe cambiata',
  ),
  [EventCategory.CameraStreamsProfileSlotsChanged]: e(
    'streams',
    'Stream profile slots changed',
    'Slot dei profili stream cambiati',
  ),
  [EventCategory.StreamOnline]: e('streams', 'Stream online', 'Stream online'),
  [EventCategory.StreamOffline]: e('streams', 'Stream offline', 'Stream offline'),
  [EventCategory.NetworkTunnelStarted]: e('network', 'Tunnel started', 'Tunnel avviato'),
  [EventCategory.NetworkTunnelStopped]: e('network', 'Tunnel stopped', 'Tunnel fermato'),
  [EventCategory.LocalNetworkChanged]: e(
    'network',
    'Local network changed',
    'Rete locale cambiata',
  ),
  [EventCategory.MeshNetworkChanged]: e('network', 'Mesh network changed', 'Rete mesh cambiata'),
  [EventCategory.BackupCompleted]: e('backup', 'Backup completed', 'Backup completato'),
  [EventCategory.BackupRunCompleted]: e(
    'backup',
    'Backup run completed',
    'Esecuzione backup completata',
  ),
  [EventCategory.BackupRestored]: e('backup', 'Backup restored', 'Backup ripristinato'),
  [EventCategory.NotificationDispatched]: e(
    'notifications',
    'Notification sent',
    'Notifica inviata',
  ),
  [EventCategory.NotificationFailed]: e(
    'notifications',
    'Notification failed',
    'Notifica non riuscita',
  ),
  [EventCategory.NotificationRuleBroken]: e(
    'notifications',
    'Notification rule broken',
    'Regola di notifica non valida',
  ),
  [EventCategory.NotificationRuleRepaired]: e(
    'notifications',
    'Notification rule repaired',
    'Regola di notifica riparata',
  ),
  [EventCategory.MigrationFailed]: e('system', 'Migration failed', 'Migrazione fallita'),
  [EventCategory.MigrationApplied]: e('system', 'Migration applied', 'Migrazione applicata'),
  [EventCategory.DeviceUpdated]: e('devices', 'Device updated', 'Dispositivo aggiornato'),
  [EventCategory.DeviceOnline]: e('devices', 'Device online', 'Dispositivo online'),
  [EventCategory.DeviceOffline]: e('devices', 'Device offline', 'Dispositivo offline'),
  [EventCategory.DeviceAwake]: e('devices', 'Device awake', 'Dispositivo attivo'),
  [EventCategory.DeviceSleeping]: e('devices', 'Device sleeping', 'Dispositivo in standby'),
  [EventCategory.RetentionCleanup]: e(
    'storage',
    'Retention cleanup',
    'Pulizia della conservazione',
  ),
  [EventCategory.AddonsBulkUpdateProgress]: e(
    'addons',
    'Bulk update progress',
    'Avanzamento aggiornamento multiplo',
  ),
  [EventCategory.AddonsJobProgress]: e(
    'addons',
    'Addon job progress',
    'Avanzamento attività addon',
  ),
  [EventCategory.AddonsJobLog]: e('addons', 'Addon job log', 'Log attività addon'),
  [EventCategory.AccessoriesChildVisibilityChanged]: e(
    'devices',
    'Child visibility changed',
    'Visibilità del dispositivo figlio cambiata',
  ),
  [EventCategory.AccessoriesChanged]: e('devices', 'Accessories changed', 'Accessori cambiati'),
  [EventCategory.ActionsRunChanged]: e(
    'system',
    'Action run changed',
    'Esecuzione dell’azione cambiata',
  ),
  [EventCategory.ModelConvertProgress]: e(
    'pipeline',
    'Model conversion progress',
    'Avanzamento conversione modello',
  ),
}

/** Every distinct category value of the enum. */
export function catalogedEventCategories(): readonly EventCategory[] {
  const all = Object.values(EventCategory).filter(
    (value): value is EventCategory => typeof value === 'string',
  )
  return [...new Set<EventCategory>(all)]
}

/** The raw ids a picker may offer: public (not owner-only), not deprecated. Sorted. */
export function offerableEventCategories(): readonly EventCategory[] {
  return catalogedEventCategories()
    .filter((c) => !isOwnerOnlyEventCategory(c) && !EVENT_CATEGORY_CATALOG[c].deprecated)
    .toSorted()
}

/** Categories marked `noise`: what the ring-buffer deny list and live views consume. Sorted. */
export function noiseEventCategories(): readonly EventCategory[] {
  return catalogedEventCategories()
    .filter((c) => EVENT_CATEGORY_CATALOG[c].noise)
    .toSorted()
}
