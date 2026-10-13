import Testing
@testable import OpenClaw

struct HostEnvSanitizerTests {
    private static let searchPaths = ["/usr/bin", "/bin"]

    @Test(arguments: [false, true])
    func `app owned search paths replace inherited path and reject request overrides`(shellWrapper: Bool) {
        let searchPaths = ["/app-owned/bin", "/usr/bin"]
        let inherited = HostEnvSanitizer.sanitize(
            searchPaths: searchPaths,
            overrides: nil,
            shellWrapper: shellWrapper)
        let overridden = HostEnvSanitizer.sanitize(
            searchPaths: searchPaths,
            overrides: ["PATH": "/request-owned/bin", "Path": "/request-owned/bin"],
            shellWrapper: shellWrapper)

        #expect(inherited["PATH"] == "/app-owned/bin:/usr/bin")
        #expect(overridden["PATH"] == "/app-owned/bin:/usr/bin")
        #expect(overridden["Path"] == nil)
    }

    @Test(arguments: ["cat", ""])
    func `no pager overrides never forward an executable`(value: String) {
        let overrides = ["GIT_PAGER": value, "PAGER": value]
        for shellWrapper in [false, true] {
            let env = HostEnvSanitizer.sanitize(
                searchPaths: Self.searchPaths,
                overrides: overrides,
                shellWrapper: shellWrapper)
            #expect(env["GIT_PAGER"]?.isEmpty == true)
            #expect(env["PAGER"]?.isEmpty == true)
        }
    }

    @Test(arguments: ["less", "/bin/cat", "./cat", "CAT", " cat", "cat ", "cat\n", "cat -u", "cat; id", "$(id)"])
    func `executable and near miss pager overrides stay blocked`(value: String) {
        for shellWrapper in [false, true] {
            let inherited = HostEnvSanitizer.sanitize(
                searchPaths: Self.searchPaths,
                overrides: nil,
                shellWrapper: shellWrapper)
            let env = HostEnvSanitizer.sanitize(
                searchPaths: Self.searchPaths,
                overrides: [" git_pager ": value, "PaGeR": value],
                shellWrapper: shellWrapper)
            #expect(env["git_pager"] == inherited["git_pager"])
            #expect(env["PaGeR"] == inherited["PaGeR"])
        }
    }

    @Test func `pager exception does not relax other denials`() {
        let inherited = HostEnvSanitizer.sanitize(searchPaths: Self.searchPaths, overrides: nil)
        let env = HostEnvSanitizer.sanitize(searchPaths: Self.searchPaths, overrides: [
            "MANPAGER": "cat", "PATH": "cat", "LD_PRELOAD": "", "BAD-KEY": "cat",
        ])
        #expect(env["MANPAGER"] == inherited["MANPAGER"])
        #expect(env["PATH"] == inherited["PATH"])
        #expect(env["LD_PRELOAD"] == nil)
        #expect(env["BAD-KEY"] == inherited["BAD-KEY"])
    }

    @Test func `sanitize blocks shell trace variables`() {
        let env = HostEnvSanitizer.sanitize(searchPaths: Self.searchPaths, overrides: [
            "SHELLOPTS": "xtrace",
            "PS4": "$(touch /tmp/pwned)",
            "OPENCLAW_TEST": "1",
        ])
        #expect(env["SHELLOPTS"] == nil)
        #expect(env["PS4"] == nil)
        #expect(env["OPENCLAW_TEST"] == "1")
    }

    @Test func `sanitize shell wrapper allows only explicit override keys`() {
        let env = HostEnvSanitizer.sanitize(
            searchPaths: Self.searchPaths,
            overrides: [
                "LANG": "C",
                "LC_ALL": "C",
                "OPENCLAW_TOKEN": "secret",
                "PS4": "$(touch /tmp/pwned)",
            ],
            shellWrapper: true)

        #expect(env["LANG"] == "C")
        #expect(env["LC_ALL"] == "C")
        #expect(env["OPENCLAW_TOKEN"] == nil)
        #expect(env["PS4"] == nil)
    }

    @Test func `sanitize non shell wrapper keeps regular overrides`() {
        let env = HostEnvSanitizer.sanitize(searchPaths: Self.searchPaths, overrides: ["OPENCLAW_TOKEN": "secret"])
        #expect(env["OPENCLAW_TOKEN"] == "secret")
    }

    @Test func `sanitize rejects blocked and invalid keys`() {
        let inherited = HostEnvSanitizer.sanitize(searchPaths: Self.searchPaths, overrides: nil)
        let env = HostEnvSanitizer.sanitize(searchPaths: Self.searchPaths, overrides: [
            "CLASSPATH": "/tmp/evil-classpath",
            "BAD-KEY": "x",
            "ProgramFiles(x86)": "C:\\Program Files (x86)",
        ])

        #expect(env["CLASSPATH"] == nil)
        #expect(env["BAD-KEY"] == inherited["BAD-KEY"])
        #expect(env["ProgramFiles(x86)"] == "C:\\Program Files (x86)")
    }

    @Test func `sanitize accepts Windows-style override key names`() {
        let env = HostEnvSanitizer.sanitize(searchPaths: Self.searchPaths, overrides: [
            "ProgramFiles(x86)": "D:\\SDKs",
            "CommonProgramFiles(x86)": "D:\\Common",
        ])
        #expect(env["ProgramFiles(x86)"] == "D:\\SDKs")
        #expect(env["CommonProgramFiles(x86)"] == "D:\\Common")
    }
}
