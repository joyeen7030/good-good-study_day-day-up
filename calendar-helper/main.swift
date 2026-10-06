import Foundation
import EventKit

struct CalendarWriteResult: Codable {
    let ok: Bool
    let eventIdentifier: String?
    let calendarTitle: String?
    let error: String?
}

final class AuthorizationBox: @unchecked Sendable {
    private let lock = NSLock()
    private var granted = false
    private var errorMessage: String?
    func set(_ value: Bool, error: String?) { lock.lock(); granted = value; errorMessage = error; lock.unlock() }
    func get() -> Bool { lock.lock(); defer { lock.unlock() }; return granted }
    func error() -> String? { lock.lock(); defer { lock.unlock() }; return errorMessage }
}

@main
struct CalendarWriter {
    static func emit(_ result: CalendarWriteResult) -> Never {
        let data = try! JSONEncoder().encode(result)
        if CommandLine.arguments.count == 6 {
            try? data.write(to: URL(fileURLWithPath: CommandLine.arguments[5]), options: .atomic)
        } else {
            print(String(data: data, encoding: .utf8)!)
        }
        exit(result.ok ? 0 : 1)
    }

    static func main() {
        guard CommandLine.arguments.count == 6,
              let startMs = Double(CommandLine.arguments[3]),
              let endMs = Double(CommandLine.arguments[4]) else {
            emit(CalendarWriteResult(ok: false, eventIdentifier: nil, calendarTitle: nil, error: "日历事件参数无效。"))
        }
        let title = CommandLine.arguments[1]
        let notes = "Task Companion 记录：\(CommandLine.arguments[2])"
        let store = EKEventStore()
        let semaphore = DispatchSemaphore(value: 0)
        let authorization = AuthorizationBox()
        if #available(macOS 14.0, *) {
            store.requestWriteOnlyAccessToEvents { granted, error in
                authorization.set(granted, error: error?.localizedDescription)
                semaphore.signal()
            }
        } else {
            store.requestAccess(to: .event) { granted, error in
                authorization.set(granted, error: error?.localizedDescription)
                semaphore.signal()
            }
        }
        semaphore.wait()
        guard authorization.get() else {
            let status = EKEventStore.authorizationStatus(for: .event)
            let message: String
            if status == .denied {
                message = "日历权限此前已被拒绝或系统未显示授权提示。请到系统设置 > 隐私与安全性 > 日历，允许 Task Companion Calendar Writer 访问。"
            } else if status == .restricted {
                message = "此 Mac 的系统策略限制了日历访问。"
            } else {
                message = authorization.error() ?? "macOS 没有完成日历授权。请到系统设置 > 隐私与安全性 > 日历检查 Task Companion Calendar Writer。"
            }
            emit(CalendarWriteResult(ok: false, eventIdentifier: nil, calendarTitle: nil, error: message))
        }
        guard let calendar = store.defaultCalendarForNewEvents else {
            emit(CalendarWriteResult(ok: false, eventIdentifier: nil, calendarTitle: nil, error: "Mac 默认日历不可用，请先在日历 App 中设置一个默认日历。"))
        }
        let event = EKEvent(eventStore: store)
        event.calendar = calendar
        event.title = title
        event.startDate = Date(timeIntervalSince1970: startMs / 1000)
        event.endDate = Date(timeIntervalSince1970: endMs / 1000)
        event.notes = notes
        do {
            try store.save(event, span: .thisEvent, commit: true)
            emit(CalendarWriteResult(ok: true, eventIdentifier: event.eventIdentifier, calendarTitle: calendar.title, error: nil))
        } catch {
            emit(CalendarWriteResult(ok: false, eventIdentifier: nil, calendarTitle: nil, error: "写入日历失败：\(error.localizedDescription)"))
        }
    }
}
