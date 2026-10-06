import AppKit
import SwiftUI
import UserNotifications

@MainActor
final class CompanionModel: ObservableObject {
    @Published var taskTitle = ""
    @Published var taskId = ""
    @Published var isActive = false
    @Published var isPaused = false
    @Published var recoveryRequired = false
    @Published var windowVisible = true
    @Published var opacity = UserDefaults.standard.object(forKey: "floatingOpacity") as? Double ?? 1.0
    @Published var panelPreset = UserDefaults.standard.string(forKey: "floatingSize") ?? "standard"
    @Published var appearanceExpanded = false
    @Published var awaitingProgress = false
    @Published var promptText = ""
    @Published var remainingText = "--:--"
    @Published var progressText = ""
    @Published var errorText = ""
    private var focus: [String: Any] = [:]
    private var lastNoticeId = UserDefaults.standard.string(forKey: "lastNoticeId") ?? ""
    private var polling = false

    var panelWidth: CGFloat {
        switch panelPreset { case "compact": return 360; case "roomy": return 560; default: return 440 }
    }

    var panelHeight: CGFloat {
        switch panelPreset { case "compact": return 190; case "roomy": return 250; default: return 215 }
    }

    private func parseDate(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: text)
    }

    func poll() async {
        guard !polling else { return }
        polling = true
        defer { polling = false }
        do {
            let state = try await request("GET", "/api/state") as? [String: Any] ?? [:]
            recoveryRequired = state["focusRecoveryRequired"] as? Bool ?? false
            let settings = state["settings"] as? [String: Any] ?? [:]
            windowVisible = settings["companionVisible"] as? Bool ?? true
            let dailyTasks = state["dailyTasks"] as? [[String: Any]] ?? []
            guard let currentFocus = state["focus"] as? [String: Any],
                  let currentTaskId = currentFocus["taskId"] as? String,
                  let task = dailyTasks.first(where: { $0["id"] as? String == currentTaskId }) else {
                isActive = false
                taskTitle = ""
                focus = [:]
                return
            }
            focus = currentFocus
            taskId = currentTaskId
            taskTitle = task["title"] as? String ?? "正在进行的任务"
            isActive = true
            isPaused = currentFocus["paused"] as? Bool ?? false
            let nextReminder = parseDate(currentFocus["nextReminderAt"])
            let acknowledged = parseDate(currentFocus["acknowledgedAt"]) ?? .distantPast
            let lastPrompt = parseDate(currentFocus["lastPromptAt"])
            awaitingProgress = !recoveryRequired && !isPaused && ((lastPrompt != nil && lastPrompt! > acknowledged) || (nextReminder != nil && nextReminder! <= Date()))
            if recoveryRequired {
                promptText = "计时跨过了午夜，已暂停。先在看板选择昨天的结束时间，或确认继续。"
            } else if awaitingProgress, let lastPrompt, lastPrompt > acknowledged {
                promptText = "时间到了。别写‘还在做’——具体交代产出了什么，或者卡在哪里。"
                await deliverNotification(for: currentTaskId, promptAt: currentFocus["lastPromptAt"] as? String ?? "")
            } else if awaitingProgress {
                promptText = "时间到了。进度如何？说清楚已经推进到哪，或卡在哪。"
                if let reminder = try? await request("POST", "/api/focus/reminder", body: [:]) as? [String: Any],
                   let info = reminder["reminder"] as? [String: Any] {
                    let promptAt = info["promptAt"] as? String ?? ""
                    promptText = "时间到了。别写‘还在做’——具体交代产出了什么，或者卡在哪里。"
                    await deliverNotification(for: currentTaskId, promptAt: promptAt)
                    _ = try? await request("GET", "/api/state")
                }
            } else {
                promptText = ""
            }
            let start = parseDate(currentFocus["startedAt"]) ?? Date()
            let end = isPaused ? (parseDate(currentFocus["pausedAt"]) ?? Date()) : Date()
            let expected = (currentFocus["expectedMinutes"] as? Double ?? 25) * 60
            let elapsed = max(0, end.timeIntervalSince(start))
            let remaining = max(0, Int(expected - elapsed))
            remainingText = String(format: "%02d:%02d", remaining / 60, remaining % 60)
            errorText = ""
        } catch {
            errorText = "看板服务暂时连不上。"
        }
    }

    func submitProgress() async {
        let text = progressText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { errorText = "写下进展，别留空。"; return }
        do {
            _ = try await request("POST", "/api/progress/log", body: ["taskId": taskId, "message": text])
            progressText = ""
            errorText = ""
            await poll()
        } catch { errorText = error.localizedDescription }
    }

    func pause() async { await action("/api/focus/pause", ["paused": !isPaused]) }
    func stop() async { await action("/api/focus/stop", ["complete": false]) }
    func finish() async { await action("/api/focus/stop", ["complete": true, "calendarEvent": true]) }
    func setWindowVisible(_ visible: Bool) async {
        do {
            _ = try await request("POST", "/api/companion/window", body: ["visible": visible])
            windowVisible = visible
        } catch { errorText = error.localizedDescription }
    }

    private func action(_ path: String, _ body: [String: Any]) async {
        do { _ = try await request("POST", path, body: body); await poll() }
        catch { errorText = error.localizedDescription }
    }

    private func deliverNotification(for task: String, promptAt: String) async {
        guard !promptAt.isEmpty else { return }
        let identifier = "\(task)-\(promptAt)"
        guard identifier != lastNoticeId else { return }
        lastNoticeId = identifier
        UserDefaults.standard.set(identifier, forKey: "lastNoticeId")
        let content = UNMutableNotificationContent()
        content.title = "陪跑时间到了"
        content.subtitle = taskTitle
        content.body = "别只盯着计时器。打开悬浮栏，交代进度或卡点。"
        content.sound = .default
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
        NotificationCenter.default.post(name: .companionNeedsAttention, object: nil)
    }

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> Any {
        var urlRequest = URLRequest(url: URL(string: "http://127.0.0.1:43129\(path)")!)
        urlRequest.httpMethod = method
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw NSError(domain: "TaskCompanion", code: 1, userInfo: [NSLocalizedDescriptionKey: payload?["error"] as? String ?? "看板操作失败。"])
        }
        return try JSONSerialization.jsonObject(with: data)
    }
}

extension Notification.Name { static let companionNeedsAttention = Notification.Name("companionNeedsAttention") }

struct FloatingCompanionView: View {
    @ObservedObject var model: CompanionModel
    var close: () -> Void
    var openDashboard: () -> Void
    var updateLayout: () -> Void
    var updateOpacity: (Double) -> Void
    var updatePreset: (String) -> Void

    private func presetTitle(_ preset: String) -> String {
        switch preset { case "compact": return "紧凑"; case "roomy": return "宽敞"; default: return "标准" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text("✳").foregroundStyle(Color(red: 0.12, green: 0.38, blue: 0.34))
                Text("陪跑助手").font(.system(size: 14, weight: .bold))
                Spacer()
                Text("置顶").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                Button(model.appearanceExpanded ? "收起" : "外观") {
                    model.appearanceExpanded.toggle()
                    updateLayout()
                }.buttonStyle(.plain).font(.system(size: 11, weight: .medium))
                Button("×", action: close).buttonStyle(.plain).foregroundStyle(.secondary)
            }
            if model.isActive {
                HStack(alignment: .firstTextBaseline) {
                    Text(model.taskTitle).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 12)
                    Text(model.isPaused ? "已暂停" : model.remainingText).font(.system(size: 20, weight: .bold, design: .monospaced)).foregroundStyle(Color(red: 0.12, green: 0.38, blue: 0.34))
                }
                if model.recoveryRequired {
                    Text(model.promptText).font(.system(size: 12, weight: .semibold)).foregroundStyle(Color(red: 0.58, green: 0.25, blue: 0.20))
                    Button("处理跨日计时") { openDashboard() }.buttonStyle(.borderedProminent).tint(Color(red: 0.12, green: 0.38, blue: 0.34))
                } else if model.awaitingProgress {
                    Text(model.promptText).font(.system(size: 12, weight: .semibold)).foregroundStyle(Color(red: 0.58, green: 0.25, blue: 0.20))
                    HStack {
                        TextField("交代产出或卡点", text: $model.progressText, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(1...3)
                            .onSubmit { Task { await model.submitProgress() } }
                        Button("汇报") { Task { await model.submitProgress() } }.buttonStyle(.borderedProminent).tint(Color(red: 0.12, green: 0.38, blue: 0.34))
                    }
                }
                if !model.recoveryRequired {
                    HStack(spacing: 7) {
                        Button(model.isPaused ? "继续" : "暂停") { Task { await model.pause() } }
                        Button("结束陪跑") { Task { await model.stop() } }
                        Button("完成") { Task { await model.finish() } }.buttonStyle(.borderedProminent).tint(Color(red: 0.12, green: 0.38, blue: 0.34))
                        Spacer()
                        Button("打开看板") { openDashboard() }.buttonStyle(.link)
                    }.controlSize(.small)
                }
            } else {
                Text("没有正在进行的陪跑。选择一件事，开始计时。")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                Button("打开看板") { openDashboard() }.buttonStyle(.borderedProminent).tint(Color(red: 0.12, green: 0.38, blue: 0.34))
            }
            if model.appearanceExpanded {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("透明度").font(.system(size: 11, weight: .medium))
                        Slider(value: Binding(get: { model.opacity }, set: updateOpacity), in: 0.4...1.0, step: 0.05)
                        Text("\(Int(model.opacity * 100))%").font(.system(size: 10, design: .monospaced)).frame(width: 34, alignment: .trailing)
                    }
                    HStack(spacing: 7) {
                        Text("面板大小").font(.system(size: 11, weight: .medium))
                        ForEach(["compact", "standard", "roomy"], id: \.self) { preset in
                            Button(presetTitle(preset)) { updatePreset(preset) }
                                .buttonStyle(.bordered)
                                .tint(model.panelPreset == preset ? Color(red: 0.12, green: 0.38, blue: 0.34) : .gray)
                        }
                    }
                }
                .padding(10)
                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
            }
            if !model.errorText.isEmpty { Text(model.errorText).font(.system(size: 10)).foregroundStyle(.red) }
        }
        .padding(15)
        .frame(width: model.panelWidth)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let model = CompanionModel()
    var panel: NSPanel!
    var statusItem: NSStatusItem!
    var pollTask: Task<Void, Never>?
    var lastAppliedPanelSize: NSSize?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "伴"
        statusItem.button?.toolTip = "Task Companion 陪跑悬浮栏"
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePanel)
        let rect = NSRect(x: 0, y: 0, width: model.panelWidth, height: model.panelHeight)
        panel = NSPanel(contentRect: rect, styleMask: [.titled, .nonactivatingPanel, .utilityWindow], backing: .buffered, defer: false)
        panel.title = "Task Companion"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = true
        panel.isOpaque = false
        panel.alphaValue = model.opacity
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.contentView = NSHostingView(rootView: FloatingCompanionView(model: model, close: { [weak self] in
            guard let self else { return }
            panel.orderOut(nil)
            Task { @MainActor in await self.model.setWindowVisible(false) }
        }, openDashboard: { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:43129/")!) }, updateLayout: { [weak self] in self?.applyPanelSize() }, updateOpacity: { [weak self] value in self?.applyOpacity(value) }, updatePreset: { [weak self] preset in self?.applyPreset(preset) }))
        placePanel()
        pollTask = Task {
            while !Task.isCancelled {
                await model.poll()
                applyPanelSize()
                if model.windowVisible && !panel.isVisible { panel.orderFrontRegardless() }
                if !model.windowVisible && panel.isVisible { panel.orderOut(nil) }
                try? await Task.sleep(for: .seconds(5))
            }
        }
        NotificationCenter.default.addObserver(forName: .companionNeedsAttention, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.panel.orderFrontRegardless() }
        }
    }

    func applicationWillTerminate(_ notification: Notification) { pollTask?.cancel() }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .sound] }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async { panel.orderFrontRegardless(); NSApp.activate(ignoringOtherApps: true) }

    @objc func togglePanel() {
        let shouldShow = !model.windowVisible
        if shouldShow { placePanel(); panel.orderFrontRegardless(); NSApp.activate(ignoringOtherApps: true) }
        Task { await model.setWindowVisible(shouldShow) }
    }

    private func placePanel() {
        guard let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        panel.setFrameOrigin(NSPoint(x: visible.maxX - panel.frame.width - 20, y: visible.maxY - panel.frame.height - 14))
    }

    private func applyOpacity(_ value: Double) {
        model.opacity = value
        UserDefaults.standard.set(value, forKey: "floatingOpacity")
        panel.alphaValue = value
    }

    private func applyPreset(_ preset: String) {
        model.panelPreset = preset
        UserDefaults.standard.set(preset, forKey: "floatingSize")
        applyPanelSize()
    }

    private func applyPanelSize() {
        let settingsHeight: CGFloat = model.appearanceExpanded ? 100 : 0
        let promptHeight: CGFloat = model.awaitingProgress || model.recoveryRequired ? 36 : 0
        let size = NSSize(width: model.panelWidth, height: model.panelHeight + settingsHeight + promptHeight)
        guard lastAppliedPanelSize != size else { return }
        panel.setContentSize(size)
        lastAppliedPanelSize = size
    }
}

@main
struct TaskCompanionAssistantApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene { Settings { EmptyView() } }
}
