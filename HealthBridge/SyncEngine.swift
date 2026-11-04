import BackgroundTasks
import CoreLocation
import Foundation
import HealthKit
import WidgetKit

// Synchronization with the Cloudflare collection endpoint.
// For each data type, an anchored query returns only new samples (and deleted ones)
// since the last upload. The anchor is saved only after the server OK response:
// if the server doesn't respond, data stays queued for the next run.

enum SyncKeys {
    static let lastSuccessAt = "sync.lastSuccessAt"
    static let lastError = "sync.lastError"
    static let lastErrorAt = "sync.lastErrorAt"
    static let totalSent = "sync.totalSent"
    static let needsAuthorization = "sync.needsAuthorization"
    fileprivate static let historyStart = "sync.historyStart"
    fileprivate static let dailyBackfillVersion = "sync.dailyBackfillVersion"
    fileprivate static let lastDailyAt = "sync.lastDailyAt"
    static let lastCalendarAt = "sync.lastCalendarAt"
    fileprivate static let dailyResendFrom = "sync.dailyResendFrom"
    fileprivate static let medicationsAuthorized = "sync.medicationsAuthorized"
    fileprivate static func format(_ type: HKSampleType) -> String { "sync.format.\(type.identifier)" }
    fileprivate static func anchor(_ type: HKSampleType) -> String { "sync.anchor.\(type.identifier)" }
}

actor SyncEngine {
    static let shared = SyncEngine()

    // Static because observers also need it; they start at launch outside the actor.
    private static let store = HKHealthStore()

    // First sync: 14 days of history. Enough for two-week comparison and stay
    // under the free D1 limit (100,000 rows written per day).
    private static let historyDays = 14
    private static let batchSize = 2000
    // A GPS route weighs up to 150 KB (5-hour hike): 5 per upload stay
    // under the server's 1.9 MB limit.
    private static let routeBatchSize = 5
    private static let dailyInterval: TimeInterval = 30 * 60

    // Types sent as raw samples, with the unit they are stored in.
    private static let quantityUnits: [HKQuantityTypeIdentifier: (unit: HKUnit, label: String)] = [
        .heartRate: (.count().unitDivided(by: .minute()), "count/min"),
        .restingHeartRate: (.count().unitDivided(by: .minute()), "count/min"),
        .walkingHeartRateAverage: (.count().unitDivided(by: .minute()), "count/min"),
        .heartRateRecoveryOneMinute: (.count().unitDivided(by: .minute()), "count/min"),
        .heartRateVariabilitySDNN: (.secondUnit(with: .milli), "ms"),
        .heartRateVariabilityRMSSD: (.secondUnit(with: .milli), "ms"),
        .vo2Max: (HKUnit(from: "ml/kg*min"), "ml/kg/min"),
        .respiratoryRate: (.count().unitDivided(by: .minute()), "count/min"),
        .oxygenSaturation: (.percent(), "%"),
        .appleSleepingWristTemperature: (.degreeCelsius(), "degC"),
        .stepCount: (.count(), "count"),
        .activeEnergyBurned: (.kilocalorie(), "kcal"),
        .distanceWalkingRunning: (.meter(), "m"),
        .appleExerciseTime: (.minute(), "min"),
        .bodyMass: (.gramUnit(with: .kilo), "kg"),
        .bodyFatPercentage: (.percent(), "%"),
        .leanBodyMass: (.gramUnit(with: .kilo), "kg"),
        .bloodPressureSystolic: (.millimeterOfMercury(), "mmHg"),
        .bloodPressureDiastolic: (.millimeterOfMercury(), "mmHg"),
        .bodyTemperature: (.degreeCelsius(), "degC"),
        .appleSleepingBreathingDisturbances: (.count(), "count"),
        .timeInDaylight: (.minute(), "min"),
        .workoutEffortScore: (.appleEffortScore(), "effort"),
        .estimatedWorkoutEffortScore: (.appleEffortScore(), "effort"),
        .dietaryEnergyConsumed: (.kilocalorie(), "kcal"),
        .dietaryProtein: (.gram(), "g"),
        .dietaryCarbohydrates: (.gram(), "g"),
        .dietaryFatTotal: (.gram(), "g"),
        .dietaryWater: (.literUnit(with: .milli), "mL"),
        .dietaryCaffeine: (.gramUnit(with: .milli), "mg"),
        .numberOfAlcoholicBeverages: (.count(), "count"),
        .bloodAlcoholContent: (.percent(), "%"),
        // Micronutrients, from nutrition apps: grams, milligrams, or micrograms.
        .dietarySugar: (.gram(), "g"),
        .dietaryFiber: (.gram(), "g"),
        .dietaryFatSaturated: (.gram(), "g"),
        .dietaryFatMonounsaturated: (.gram(), "g"),
        .dietaryFatPolyunsaturated: (.gram(), "g"),
        .dietaryCholesterol: (.gramUnit(with: .milli), "mg"),
        .dietarySodium: (.gramUnit(with: .milli), "mg"),
        .dietaryPotassium: (.gramUnit(with: .milli), "mg"),
        .dietaryCalcium: (.gramUnit(with: .milli), "mg"),
        .dietaryIron: (.gramUnit(with: .milli), "mg"),
        .dietaryMagnesium: (.gramUnit(with: .milli), "mg"),
        .dietaryPhosphorus: (.gramUnit(with: .milli), "mg"),
        .dietaryZinc: (.gramUnit(with: .milli), "mg"),
        .dietaryCopper: (.gramUnit(with: .milli), "mg"),
        .dietaryManganese: (.gramUnit(with: .milli), "mg"),
        .dietarySelenium: (.gramUnit(with: .micro), "mcg"),
        .dietaryIodine: (.gramUnit(with: .micro), "mcg"),
        .dietaryChromium: (.gramUnit(with: .micro), "mcg"),
        .dietaryMolybdenum: (.gramUnit(with: .micro), "mcg"),
        .dietaryChloride: (.gramUnit(with: .milli), "mg"),
        .dietaryBiotin: (.gramUnit(with: .micro), "mcg"),
        .dietaryFolate: (.gramUnit(with: .micro), "mcg"),
        .dietaryNiacin: (.gramUnit(with: .milli), "mg"),
        .dietaryPantothenicAcid: (.gramUnit(with: .milli), "mg"),
        .dietaryRiboflavin: (.gramUnit(with: .milli), "mg"),
        .dietaryThiamin: (.gramUnit(with: .milli), "mg"),
        .dietaryVitaminA: (.gramUnit(with: .micro), "mcg"),
        .dietaryVitaminB6: (.gramUnit(with: .milli), "mg"),
        .dietaryVitaminB12: (.gramUnit(with: .micro), "mcg"),
        .dietaryVitaminC: (.gramUnit(with: .milli), "mg"),
        .dietaryVitaminD: (.gramUnit(with: .micro), "mcg"),
        .dietaryVitaminE: (.gramUnit(with: .milli), "mg"),
        .dietaryVitaminK: (.gramUnit(with: .micro), "mcg"),
        // Running, swimming, cycling, and diving.
        .runningPower: (.watt(), "W"),
        .runningSpeed: (metersPerSecond, "m/s"),
        .runningStrideLength: (.meter(), "m"),
        .runningVerticalOscillation: (.meterUnit(with: .centi), "cm"),
        .runningGroundContactTime: (.secondUnit(with: .milli), "ms"),
        .distanceSwimming: (.meter(), "m"),
        .swimmingStrokeCount: (.count(), "count"),
        .underwaterDepth: (.meter(), "m"),
        .waterTemperature: (.degreeCelsius(), "degC"),
        .distanceCycling: (.meter(), "m"),
        .cyclingPower: (.watt(), "W"),
        .cyclingSpeed: (metersPerSecond, "m/s"),
        .cyclingCadence: (.count().unitDivided(by: .minute()), "count/min"),
        .cyclingFunctionalThresholdPower: (.watt(), "W"),
        .distanceDownhillSnowSports: (.meter(), "m"),
        .distanceCrossCountrySkiing: (.meter(), "m"),
        .crossCountrySkiingSpeed: (metersPerSecond, "m/s"),
        .distanceRowing: (.meter(), "m"),
        .rowingSpeed: (metersPerSecond, "m/s"),
        .distancePaddleSports: (.meter(), "m"),
        .paddleSportsSpeed: (metersPerSecond, "m/s"),
        .distanceSkatingSports: (.meter(), "m"),
        // Daily movement and walking.
        .physicalEffort: (.kilocalorie().unitDivided(by: HKUnit.gramUnit(with: .kilo).unitMultiplied(by: .hour())), "kcal/kg/h"),
        .basalEnergyBurned: (.kilocalorie(), "kcal"),
        .appleStandTime: (.minute(), "min"),
        .appleMoveTime: (.minute(), "min"),
        .flightsClimbed: (.count(), "count"),
        .walkingSpeed: (metersPerSecond, "m/s"),
        .walkingStepLength: (.meter(), "m"),
        .walkingAsymmetryPercentage: (.percent(), "%"),
        .walkingDoubleSupportPercentage: (.percent(), "%"),
        .appleWalkingSteadiness: (.percent(), "%"),
        .sixMinuteWalkTestDistance: (.meter(), "m"),
        .stairAscentSpeed: (metersPerSecond, "m/s"),
        .stairDescentSpeed: (metersPerSecond, "m/s"),
        .numberOfTimesFallen: (.count(), "count"),
        // Heart, body, and environment.
        .atrialFibrillationBurden: (.percent(), "%"),
        .height: (.meter(), "m"),
        .bodyMassIndex: (.count(), "count"),
        .waistCircumference: (.meter(), "m"),
        .bloodGlucose: (HKUnit(from: "mg/dL"), "mg/dL"),
        .uvExposure: (.count(), "count"),
        .environmentalAudioExposure: (.decibelAWeightedSoundPressureLevel(), "dBA"),
        .headphoneAudioExposure: (.decibelAWeightedSoundPressureLevel(), "dBA"),
        // Breathing, temperature, and skin.
        .forcedExpiratoryVolume1: (.liter(), "L"),
        .forcedVitalCapacity: (.liter(), "L"),
        .peakExpiratoryFlowRate: (.liter().unitDivided(by: .minute()), "L/min"),
        .inhalerUsage: (.count(), "count"),
        .peripheralPerfusionIndex: (.percent(), "%"),
        .basalBodyTemperature: (.degreeCelsius(), "degC"),
        .electrodermalActivity: (.siemenUnit(with: .micro), "uS"),
    ]

    private static let metersPerSecond = HKUnit.meter().unitDivided(by: .second())

    private static let categoryTypes: [HKCategoryTypeIdentifier] = [
        .sleepAnalysis,
        .mindfulSession,
        .highHeartRateEvent,
        .lowHeartRateEvent,
        .irregularHeartRhythmEvent,
        .appleStandHour,
        .lowCardioFitnessEvent,
        .appleWalkingSteadinessEvent,
        .sleepApneaEvent,
        .hypertensionEvent,
        .environmentalAudioExposureEvent,
        .headphoneAudioExposureEvent,
        .handwashingEvent,
        .toothbrushingEvent,
        // Symptoms logged manually in Health (excluding only menstrual ones).
        .abdominalCramps, .acne, .appetiteChanges, .bladderIncontinence, .bloating, .breastPain,
        .chestTightnessOrPain, .chills, .constipation, .coughing, .diarrhea, .dizziness, .drySkin,
        .fainting, .fatigue, .fever, .generalizedBodyAche, .hairLoss, .headache, .heartburn,
        .hotFlashes, .lossOfSmell, .lossOfTaste, .lowerBackPain, .memoryLapse, .moodChanges,
        .nausea, .nightSweats, .pelvicPain, .rapidPoundingOrFlutteringHeartbeat, .runnyNose,
        .shortnessOfBreath, .sinusCongestion, .skippedHeartbeat, .sleepChanges, .soreThroat,
        .vomiting, .wheezing,
    ]

    // Sleep and stand hours are hundreds of samples without useful metadata: no meta.
    private static let categoriesWithoutMeta: Set<String> = [
        HKCategoryTypeIdentifier.sleepAnalysis.rawValue,
        HKCategoryTypeIdentifier.appleStandHour.rawValue,
    ]

    // GPS routes for outdoor workouts.
    private static let routeType = HKSeriesType.workoutRoute()

    static let sampleTypes: [HKSampleType] =
        [HKObjectType.workoutType(), routeType, HKObjectType.stateOfMindType(), HKObjectType.electrocardiogramType()]
        + categoryTypes.map { HKCategoryType($0) }
        + quantityUnits.keys.sorted { $0.rawValue < $1.rawValue }.map { HKQuantityType($0) }

    // Medication and supplement doses have separate authorization: the user
    // chooses per medication what to share (requestMedicationAuthorization).
    private static let medicationDoseType = HKObjectType.medicationDoseEventType()

    // Data type format version: increment when the description format changes.
    // On next sync that type is resent entirely and the server overwrites
    // old rows (same uuid).
    // Doses 2: real name instead of empty nickname (2026-10-05).
    // Workouts 2: statistics, metadata, laps and segments (2026-10-05).
    // Workouts 3: start, duration, and style of each lap or segment (2026-10-06).
    private static let formatVersions: [String: Int] = [
        HKObjectType.medicationDoseEventType().identifier: 2,
        HKObjectType.workoutType().identifier: 3,
    ]

    // Daily totals version: increment when adding a metric, so totals are resent
    // once from the start of history.
    // 2: daylight and other totals added after first upload (2026-10-06).
    // 3: daily water intake (2026-10-13).
    private static let dailyBackfillVersion = 3

    // Daily totals calculated by HealthKit: only it knows how to remove duplicates
    // between iPhone and Watch. Metric names are those the server reads.
    private static let dailyMetrics: [(metric: String, type: HKQuantityType, unit: HKUnit, label: String)] = [
        ("steps", HKQuantityType(.stepCount), .count(), "count"),
        ("activeEnergy", HKQuantityType(.activeEnergyBurned), .kilocalorie(), "kcal"),
        ("basalEnergy", HKQuantityType(.basalEnergyBurned), .kilocalorie(), "kcal"),
        ("distance", HKQuantityType(.distanceWalkingRunning), .meter(), "m"),
        ("exerciseTime", HKQuantityType(.appleExerciseTime), .minute(), "min"),
        ("flights", HKQuantityType(.flightsClimbed), .count(), "count"),
        ("standTime", HKQuantityType(.appleStandTime), .minute(), "min"),
        ("daylight", HKQuantityType(.timeInDaylight), .minute(), "min"),
        ("cyclingDistance", HKQuantityType(.distanceCycling), .meter(), "m"),
        ("swimmingDistance", HKQuantityType(.distanceSwimming), .meter(), "m"),
        ("water", HKQuantityType(.dietaryWater), .literUnit(with: .milli), "mL"),
    ]

    // Demographic data: needed by the coach for calories and heart rate zones.
    private static let characteristics: [HKCharacteristicType] = [
        HKCharacteristicType(.dateOfBirth),
        HKCharacteristicType(.biologicalSex),
    ]

    static var readTypes: Set<HKObjectType> {
        Set(sampleTypes.map { $0 as HKObjectType } + dailyMetrics.map { $0.type as HKObjectType }
            + characteristics.map { $0 as HKObjectType })
    }

    private let defaults = UserDefaults.standard
    private var running = false
    private var rerun = false

    // Types that wake the app immediately on arrival (sleep, workouts, mood, alerts, values
    // measured rarely): these are what the coach looks for immediately. Others, which arrive
    // every few minutes (heart rate, steps, energy...), stay on an hourly wake
    // to save battery. Every wake sends all types anyway.
    private static let immediateQuantities: Set<HKQuantityTypeIdentifier> = [
        .restingHeartRate, .heartRateVariabilitySDNN, .heartRateVariabilityRMSSD, .vo2Max,
        .bodyMass, .bodyFatPercentage, .bloodPressureSystolic, .bloodPressureDiastolic, .bloodGlucose,
    ]

    private static func deliveryFrequency(_ type: HKSampleType) -> HKUpdateFrequency {
        if let quantity = type as? HKQuantityType {
            return immediateQuantities.contains(HKQuantityTypeIdentifier(rawValue: quantity.identifier)) ? .immediate : .hourly
        }
        return type.identifier == HKCategoryTypeIdentifier.appleStandHour.rawValue ? .hourly : .immediate
    }

    // Call at every app launch, even when iOS wakes in background:
    // observers must be re-registered each time.
    nonisolated static func startObserving() {
        for type in sampleTypes + [medicationDoseType] {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { _, completion, error in
                guard error == nil else {
                    completion()
                    return
                }
                Task {
                    await SyncEngine.shared.sync()
                    completion()
                }
            }
            store.execute(query)
            // If iOS doesn't accept "immediate" for a type, fall back to hourly.
            store.enableBackgroundDelivery(for: type, frequency: deliveryFrequency(type)) { success, _ in
                if !success { store.enableBackgroundDelivery(for: type, frequency: .hourly) { _, _ in } }
            }
        }
    }

    // Periodic background update (BGAppRefreshTask): an extra safety net
    // beyond observers. iOS decides when to run it; requested every 30 minutes.
    nonisolated static let refreshTaskID = "com.example.healthbridge.refresh"

    nonisolated static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    nonisolated static func handleRefresh(_ task: BGAppRefreshTask) {
        scheduleRefresh()
        let work = Task { await SyncEngine.shared.sync() }
        task.expirationHandler = { work.cancel() }
        Task {
            await work.value
            task.setTaskCompleted(success: !work.isCancelled)
        }
    }

    // The only write to Health: water logged from the app and widget.
    static let shareTypes: Set<HKSampleType> = [Water.type]

    func requestAuthorization() async throws {
        try await Self.store.requestAuthorization(toShare: Self.shareTypes, read: Self.readTypes)
    }

    // iOS shows the list of medications and supplements registered in Health and the user
    // chooses which to share. Their doses become readable along with the medication.
    func requestMedicationAuthorization() async throws {
        try await Self.store.requestPerObjectReadAuthorization(for: .userAnnotatedMedicationType(), predicate: nil)
        defaults.set(true, forKey: SyncKeys.medicationsAuthorized)
        // Doses of a newly authorized medication may be before the anchor:
        // restart from the beginning of history, the server discards duplicates.
        defaults.removeObject(forKey: SyncKeys.anchor(Self.medicationDoseType))
    }

    // Multiple close requests (one observer per type) become a single run,
    // plus a second if more arrived in the meantime.
    func sync() async {
        if running {
            rerun = true
            return
        }
        running = true
        repeat {
            rerun = false
            await performSync()
        } while rerun
        running = false
    }

    private func performSync() async {
        // Calendar and Reminders for the morning briefing: before health, so when
        // sleep arrives and triggers the briefing the calendar is already fresh. Never throws.
        await BriefingAgenda.syncIfDue()
        do {
            // Until data type access has been requested, queries see nothing but
            // anchors would advance anyway, skipping history.
            let status = try await Self.store.statusForAuthorizationRequest(toShare: Self.shareTypes, read: Self.readTypes)
            guard status == .unnecessary else {
                defaults.set(true, forKey: SyncKeys.needsAuthorization)
                return
            }
            defaults.set(false, forKey: SyncKeys.needsAuthorization)
            // Glasses logged from the widget while phone locked enter Health before upload.
            await Water.flushPending()
            var sent = 0
            for type in Self.sampleTypes + [Self.medicationDoseType] {
                // Without saved version defaults to 1: only explicitly bumped types are resent.
                let version = Self.formatVersions[type.identifier] ?? 1
                let stored = defaults.object(forKey: SyncKeys.format(type)) as? Int ?? 1
                if stored != version {
                    defaults.removeObject(forKey: SyncKeys.anchor(type))
                }
                defaults.set(version, forKey: SyncKeys.format(type))
            }
            for type in Self.sampleTypes {
                sent += try await syncSamples(of: type)
            }
            // Until medication selection is made, skip: the anchor would advance empty.
            if defaults.bool(forKey: SyncKeys.medicationsAuthorized) {
                sent += try await syncSamples(of: Self.medicationDoseType, medicationNames: try await medicationNames())
            }
            try await syncDailyTotals()
            try await syncCalendar(force: false)
            await Water.refreshToday()
            defaults.set(Date().timeIntervalSince1970, forKey: SyncKeys.lastSuccessAt)
            // The widget rereads state from the server.
            WidgetCenter.shared.reloadAllTimelines()
            defaults.set(defaults.integer(forKey: SyncKeys.totalSent) + sent, forKey: SyncKeys.totalSent)
            defaults.removeObject(forKey: SyncKeys.lastError)
        } catch {
            defaults.set(Self.describe(error), forKey: SyncKeys.lastError)
            defaults.set(Date().timeIntervalSince1970, forKey: SyncKeys.lastErrorAt)
        }
    }

    private func syncSamples(
        of type: HKSampleType,
        medicationNames: [HKHealthConceptIdentifier: String] = [:]
    ) async throws -> Int {
        var anchor = loadAnchor(for: type)
        var sent = 0
        let limit = type == Self.routeType ? Self.routeBatchSize : Self.batchSize
        while true {
            let descriptor = HKAnchoredObjectQueryDescriptor(
                predicates: [.sample(type: type, predicate: historyPredicate())],
                anchor: anchor,
                limit: limit
            )
            let result = try await descriptor.result(for: Self.store)
            var samples: [SamplePayload] = []
            if type == Self.routeType {
                for case let route as HKWorkoutRoute in result.addedSamples {
                    if let payload = try await Self.encodeRoute(route) { samples.append(payload) }
                }
            } else {
                samples = result.addedSamples.compactMap { Self.encode($0, medicationNames: medicationNames) }
            }
            let deleted = result.deletedObjects.map { $0.uuid.uuidString }
            if !samples.isEmpty || !deleted.isEmpty {
                try await post(IngestPayload(samples: samples, deleted: deleted, daily: [], profile: nil))
            }
            saveAnchor(result.newAnchor, for: type)
            sent += samples.count
            anchor = result.newAnchor
            if result.addedSamples.count + result.deletedObjects.count < limit {
                return sent
            }
        }
    }

    // Each run (at most every 30 minutes) resends the last 3 days:
    // late-arriving Watch data corrects totals. First time, all history.
    private func syncDailyTotals() async throws {
        let lastDaily = defaults.double(forKey: SyncKeys.lastDailyAt)
        guard Date().timeIntervalSince1970 - lastDaily > Self.dailyInterval else { return }

        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let backfilled = defaults.integer(forKey: SyncKeys.dailyBackfillVersion) >= Self.dailyBackfillVersion
        let recent = calendar.date(byAdding: .day, value: -2, to: today)!
        let resendFrom = (defaults.object(forKey: SyncKeys.dailyResendFrom) as? Date).map { calendar.startOfDay(for: $0) }
        let start = backfilled ? min(recent, resendFrom ?? recent) : historyStart()

        var daily: [DailyPayload] = []
        for metric in Self.dailyMetrics {
            let descriptor = HKStatisticsCollectionQueryDescriptor(
                predicate: .quantitySample(type: metric.type, predicate: HKQuery.predicateForSamples(withStart: start, end: nil)),
                options: .cumulativeSum,
                anchorDate: today,
                intervalComponents: DateComponents(day: 1)
            )
            let collection = try await descriptor.result(for: Self.store)
            for statistics in collection.statistics() {
                guard let sum = statistics.sumQuantity() else { continue }
                daily.append(DailyPayload(
                    day: Self.dayFormatter.string(from: statistics.startDate),
                    metric: metric.metric,
                    value: sum.doubleValue(for: metric.unit),
                    unit: metric.label
                ))
            }
        }
        if !daily.isEmpty {
            try await post(IngestPayload(samples: [], deleted: [], daily: daily, profile: Self.profile()))
        }
        defaults.set(Self.dailyBackfillVersion, forKey: SyncKeys.dailyBackfillVersion)
        defaults.removeObject(forKey: SyncKeys.dailyResendFrom)
        defaults.set(Date().timeIntervalSince1970, forKey: SyncKeys.lastDailyAt)
    }

    // Events (times only) and planned workouts, at most every 15 minutes; immediately
    // when the coach's plan just ended in Calendar. Without permission, nothing.
    func syncCalendar(force: Bool) async throws {
        let last = defaults.double(forKey: SyncKeys.lastCalendarAt)
        guard force || Date().timeIntervalSince1970 - last > 15 * 60,
              let payload = CalendarBridge.snapshot() else { return }
        try await post(path: "calendar", body: try JSONEncoder().encode(payload))
        defaults.set(Date().timeIntervalSince1970, forKey: SyncKeys.lastCalendarAt)
    }

    // When correcting a past day (water added or removed retroactively), daily totals
    // are resent from that day immediately, without waiting 30 minutes.
    func resendDailyTotals(from day: Date) async {
        let current = defaults.object(forKey: SyncKeys.dailyResendFrom) as? Date
        defaults.set(min(current ?? day, day), forKey: SyncKeys.dailyResendFrom)
        defaults.removeObject(forKey: SyncKeys.lastDailyAt)
        await sync()
    }

    // Name of each authorized medication or supplement: the nickname given in Health,
    // if present and not empty, otherwise the medication name.
    private func medicationNames() async throws -> [HKHealthConceptIdentifier: String] {
        let medications = try await HKUserAnnotatedMedicationQueryDescriptor().result(for: Self.store)
        return Dictionary(
            medications.map { medication in
                let nickname = medication.nickname?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let name = nickname.isEmpty
                    ? medication.medication.displayText.trimmingCharacters(in: .whitespacesAndNewlines)
                    : nickname
                return (medication.medication.identifier, name)
            },
            uniquingKeysWith: { first, _ in first }
        )
    }

    private func post(_ payload: IngestPayload) async throws {
        try await post(path: "ingest", body: try JSONEncoder().encode(payload))
    }

    private func post(path: String, body: Data) async throws {
        // The simulator has the same tokens as the iPhone: no uploads, or test data
        // would end up on the real server (success 2026-10-14 with a demo session).
        #if targetEnvironment(simulator)
        return
        #endif
        var request = URLRequest(url: Secrets.serverURL.appending(path: path))
        request.httpMethod = "POST"
        request.timeoutInterval = 25
        request.setValue("Bearer \(Secrets.ingestToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            throw SyncError.server(status: status, message: String(decoding: data, as: UTF8.self))
        }
    }

    private static func profile() -> [String: String]? {
        var profile: [String: String] = [:]
        if let birth = try? store.dateOfBirthComponents(), let y = birth.year, let m = birth.month, let d = birth.day {
            profile["dateOfBirth"] = String(format: "%04d-%02d-%02d", y, m, d)
        }
        switch (try? store.biologicalSex())?.biologicalSex {
        case .male: profile["sex"] = "male"
        case .female: profile["sex"] = "female"
        default: break
        }
        // The water goal chosen in the app: the coach compares it with what you drink.
        profile["waterGoalMl"] = String(Water.goalMl)
        return profile.isEmpty ? nil : profile
    }

    // MARK: History and anchors

    // The start date is fixed at first sync and never changes:
    // anchors only work with the same filter.
    private func historyStart() -> Date {
        if let saved = defaults.object(forKey: SyncKeys.historyStart) as? Date { return saved }
        let calendar = Calendar.current
        let start = calendar.date(byAdding: .day, value: -Self.historyDays, to: calendar.startOfDay(for: Date()))!
        defaults.set(start, forKey: SyncKeys.historyStart)
        return start
    }

    private func historyPredicate() -> NSPredicate {
        HKQuery.predicateForSamples(withStart: historyStart(), end: nil)
    }

    private func loadAnchor(for type: HKSampleType) -> HKQueryAnchor? {
        guard let data = defaults.data(forKey: SyncKeys.anchor(type)) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private func saveAnchor(_ anchor: HKQueryAnchor, for type: HKSampleType) {
        guard let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true) else { return }
        defaults.set(data, forKey: SyncKeys.anchor(type))
    }

    // MARK: Sample conversion

    private static let isoFormatter = ISO8601DateFormatter()

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static func encode(_ sample: HKSample, medicationNames: [HKHealthConceptIdentifier: String]) -> SamplePayload? {
        var value: Double?
        var unit: String?
        var meta: SampleMeta?

        switch sample {
        case let quantity as HKQuantitySample:
            guard let entry = quantityUnits[HKQuantityTypeIdentifier(rawValue: quantity.quantityType.identifier)] else { return nil }
            value = quantity.quantity.doubleValue(for: entry.unit)
            // HealthKit gives percentages as fractions (0.97): store as 97.
            if entry.label == "%" { value = value.map { $0 * 100 } }
            unit = entry.label
        case let category as HKCategorySample:
            value = Double(category.value)
            // Heart alert threshold, noise level, app that logged the symptom.
            if !categoriesWithoutMeta.contains(category.categoryType.identifier),
               let metadata = metadataStrings(category.metadata) {
                meta = SampleMeta(metadata: metadata)
            }
        case let workout as HKWorkout:
            value = workout.duration
            unit = "s"
            meta = SampleMeta(
                activityType: workout.workoutActivityType.rawValue,
                energyKcal: workout.statistics(for: HKQuantityType(.activeEnergyBurned))?
                    .sumQuantity()?.doubleValue(for: .kilocalorie()),
                distanceM: [HKQuantityTypeIdentifier.distanceWalkingRunning, .distanceCycling, .distanceSwimming]
                    .compactMap { workout.statistics(for: HKQuantityType($0))?.sumQuantity()?.doubleValue(for: .meter()) }
                    .first,
                indoor: workout.metadata?[HKMetadataKeyIndoorWorkout] as? Bool,
                stats: workoutStats(workout),
                metadata: metadataStrings(workout.metadata),
                laps: workout.workoutEvents?.filter { $0.type == .lap }.count,
                segments: workout.workoutEvents?.filter { $0.type == .segment }.count,
                events: workoutEvents(workout)
            )
        case let ecg as HKElectrocardiogram:
            value = ecg.averageHeartRate?.doubleValue(for: .count().unitDivided(by: .minute()))
            unit = "count/min"
            meta = SampleMeta(classification: ecg.classification.rawValue)
        case let mood as HKStateOfMind:
            // Valence from -1 (very unpleasant) to 1 (very pleasant).
            value = mood.valence
            unit = "valence"
            meta = SampleMeta(
                kind: mood.kind.rawValue,
                labels: mood.labels.map(\.rawValue),
                associations: mood.associations.map(\.rawValue)
            )
        case let dose as HKMedicationDoseEvent:
            value = dose.doseQuantity
            unit = dose.unit.unitString
            meta = SampleMeta(
                medication: medicationNames[dose.medicationConceptIdentifier] ?? "unnamed medication",
                status: describe(dose.logStatus),
                scheduleType: dose.scheduleType == .asNeeded ? "asNeeded" : "scheduled",
                scheduledAt: dose.scheduledDate.map { isoFormatter.string(from: $0) },
                scheduledDose: dose.scheduledDoseQuantity
            )
        default:
            return nil
        }

        return SamplePayload(
            uuid: sample.uuid.uuidString,
            type: sample.sampleType.identifier,
            start: isoFormatter.string(from: sample.startDate),
            end: isoFormatter.string(from: sample.endDate),
            value: value,
            unit: unit,
            source: sample.sourceRevision.source.name,
            meta: meta
        )
    }

    // Laps and segments: seconds from start, duration, and swim style.
    // Used for pace per 100 m, SWOLF, and style breakdown.
    private static func workoutEvents(_ workout: HKWorkout) -> [WorkoutEventPayload]? {
        let events = (workout.workoutEvents ?? []).filter { $0.type == .lap || $0.type == .segment }
        guard !events.isEmpty else { return nil }
        return events.map { event in
            WorkoutEventPayload(
                type: event.type == .lap ? "lap" : "segment",
                t: event.dateInterval.start.timeIntervalSince(workout.startDate).rounded(),
                d: (event.dateInterval.duration * 10).rounded() / 10,
                style: (event.metadata?[HKMetadataKeySwimmingStrokeStyle] as? NSNumber)?.intValue
            )
        }
    }

    // GPS route: one point every ~5 seconds (plus the last), discarding those
    // inaccurate. Each point is [seconds from start, latitude, longitude, altitude].
    private static func encodeRoute(_ route: HKWorkoutRoute) async throws -> SamplePayload? {
        var points: [[Double?]] = []
        var lastKept: Date?
        var lastSeen: CLLocation?
        let point = { (location: CLLocation) -> [Double?] in
            [
                location.timestamp.timeIntervalSince(route.startDate).rounded(),
                (location.coordinate.latitude * 1e6).rounded() / 1e6,
                (location.coordinate.longitude * 1e6).rounded() / 1e6,
                location.verticalAccuracy >= 0 ? (location.altitude * 10).rounded() / 10 : nil,
            ]
        }
        for try await location in HKWorkoutRouteQueryDescriptor(route).results(for: store) {
            guard location.horizontalAccuracy >= 0, location.horizontalAccuracy <= 50 else { continue }
            lastSeen = location
            if let lastKept, location.timestamp.timeIntervalSince(lastKept) < 5 { continue }
            lastKept = location.timestamp
            points.append(point(location))
        }
        if let lastSeen, lastSeen.timestamp != lastKept { points.append(point(lastSeen)) }
        guard !points.isEmpty else { return nil }
        return SamplePayload(
            uuid: route.uuid.uuidString,
            type: route.sampleType.identifier,
            start: isoFormatter.string(from: route.startDate),
            end: isoFormatter.string(from: route.endDate),
            value: Double(points.count),
            unit: "points",
            source: route.sourceRevision.source.name,
            meta: SampleMeta(points: points)
        )
    }

    // Statistics Apple calculates for each workout (HR, power, pace, strokes...):
    // remain even when detailed samples are deleted after 90 days.
    private static func workoutStats(_ workout: HKWorkout) -> [String: WorkoutStat]? {
        var stats: [String: WorkoutStat] = [:]
        for (type, statistics) in workout.allStatistics {
            guard let entry = quantityUnits[HKQuantityTypeIdentifier(rawValue: type.identifier)] else { continue }
            let scale = entry.label == "%" ? 100.0 : 1.0
            let read = { (q: HKQuantity?) in q.map { $0.doubleValue(for: entry.unit) * scale } }
            stats[type.identifier] = WorkoutStat(
                avg: read(statistics.averageQuantity()),
                min: read(statistics.minimumQuantity()),
                max: read(statistics.maximumQuantity()),
                sum: read(statistics.sumQuantity())
            )
        }
        return stats.isEmpty ? nil : stats
    }

    // Metadata as text: elevation gain, weather, pool length, and what third-party apps write.
    private static func metadataStrings(_ metadata: [String: Any]?) -> [String: String]? {
        guard let metadata, !metadata.isEmpty else { return nil }
        var strings: [String: String] = [:]
        for (key, value) in metadata {
            switch value {
            case let text as String: strings[key] = text
            case let number as NSNumber: strings[key] = number.stringValue
            case let quantity as HKQuantity: strings[key] = quantity.description
            case let date as Date: strings[key] = isoFormatter.string(from: date)
            default: strings[key] = String(describing: value)
            }
        }
        return strings
    }

    private static func describe(_ status: HKMedicationDoseEvent.LogStatus) -> String {
        switch status {
        case .taken: "taken"
        case .skipped: "skipped"
        case .snoozed: "snoozed"
        case .notInteracted: "notInteracted"
        case .notificationNotSent: "notificationNotSent"
        case .notLogged: "notLogged"
        @unknown default: "unknown"
        }
    }

    private static func describe(_ error: Error) -> String {
        if let error = error as? HKError, error.code == .errorDatabaseInaccessible {
            return "Phone locked: iOS doesn't allow reading Health data. Retrying at the next unlock."
        }
        if let error = error as? URLError {
            return "Server unreachable: \(error.localizedDescription)"
        }
        if case let SyncError.server(status, message) = error {
            return "The server responded \(status): \(message.prefix(200))"
        }
        return error.localizedDescription
    }
}

enum SyncError: Error {
    case server(status: Int, message: String)
}

struct IngestPayload: Encodable {
    let samples: [SamplePayload]
    let deleted: [String]
    let daily: [DailyPayload]
    let profile: [String: String]?
}

struct WorkoutStat: Encodable {
    let avg: Double?
    let min: Double?
    let max: Double?
    let sum: Double?
}

struct WorkoutEventPayload: Encodable {
    let type: String
    let t: Double
    let d: Double
    let style: Int?
}

struct SamplePayload: Encodable {
    let uuid: String
    let type: String
    let start: String
    let end: String
    let value: Double?
    let unit: String?
    let source: String
    let meta: SampleMeta?
}

// Extra details for workouts, routes, mood, doses, and alerts. Empty fields are not sent.
struct SampleMeta: Encodable {
    var activityType: UInt?
    var energyKcal: Double?
    var distanceM: Double?
    var indoor: Bool?
    var stats: [String: WorkoutStat]?
    var metadata: [String: String]?
    var laps: Int?
    var segments: Int?
    var events: [WorkoutEventPayload]?
    var points: [[Double?]]?
    var classification: Int?
    var kind: Int?
    var labels: [Int]?
    var associations: [Int]?
    var medication: String?
    var status: String?
    var scheduleType: String?
    var scheduledAt: String?
    var scheduledDose: Double?
}

struct DailyPayload: Encodable {
    let day: String
    let metric: String
    let value: Double
    let unit: String
}
