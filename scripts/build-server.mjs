#!/usr/bin/env node
// Builds the phone-side server (server/) into src-tauri/resources/stormcast-server.jar:
//   1. runs the server's protocol tests on the plain JVM, against protocol/vectors.txt
//   2. compiles the server against the Android platform jar
//   3. converts it to DEX with d8
// Needs JDK 17+ and the Android SDK (a platform >= 30 and build-tools). Skips the build when
// nothing changed; pass --force to build anyway.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PREFERRED_PLATFORM = 36;
const MIN_PLATFORM = 30;
const MIN_API = 29;
const TEST_CLASS = "com.stormitron.stormcast.server.ProtocolTest";
// Classes the JVM tests compile without Android. They must not import android.*.
const PLAIN_JAVA = ["Protocol.java", "MessageWriter.java", "Json.java", "VideoSize.java", "Options.java"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(root, "server");
const buildDir = join(serverDir, "build");
const vectors = join(root, "protocol", "vectors.txt");
const output = join(root, "src-tauri", "resources", "stormcast-server.jar");
const windows = process.platform === "win32";

const javaFiles = (dir) =>
  readdirSync(dir, { recursive: true })
    .filter((file) => file.endsWith(".java"))
    .map((file) => join(dir, file));
const mainSources = javaFiles(join(serverDir, "src", "main", "java"));
const testSources = javaFiles(join(serverDir, "src", "test", "java"));
const plainSources = mainSources.filter((file) => PLAIN_JAVA.includes(basename(file)));

const inputs = [...mainSources, ...testSources, vectors, fileURLToPath(import.meta.url)];
const newestInput = Math.max(...inputs.map((file) => statSync(file).mtimeMs));
if (!process.argv.includes("--force") && existsSync(output) && statSync(output).mtimeMs > newestInput) {
  console.log("stormcast-server.jar is up to date");
  process.exit(0);
}

const versionParts = (name) => name.split(/[^0-9]+/).filter(Boolean).map(Number);
function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function findSdk() {
  const fromEnv = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].find(
    (dir) => dir && existsSync(join(dir, "platforms")),
  );
  if (fromEnv) return fromEnv;
  // The SDK that holds the adb on PATH.
  const adb = windows ? "adb.exe" : "adb";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, adb)) && existsSync(join(dir, "..", "platforms"))) return join(dir, "..");
  }
  const local = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android", "Sdk");
  if (local && existsSync(join(local, "platforms"))) return local;
  throw new Error("Android SDK not found. Set ANDROID_HOME to the SDK folder.");
}

const sdk = findSdk();
const platforms = readdirSync(join(sdk, "platforms"))
  .filter((name) => existsSync(join(sdk, "platforms", name, "android.jar")))
  .map((name) => ({ name, api: versionParts(name)[0] ?? 0 }))
  .filter((platform) => platform.api >= MIN_PLATFORM)
  .sort((a, b) => b.api - a.api);
const platform = platforms.find((p) => p.api === PREFERRED_PLATFORM) ?? platforms[0];
if (!platform) throw new Error(`No Android platform ${MIN_PLATFORM} or newer in ${join(sdk, "platforms")}`);
const androidJar = join(sdk, "platforms", platform.name, "android.jar");

const d8Name = windows ? "d8.bat" : "d8";
const buildTools = readdirSync(join(sdk, "build-tools"))
  .filter((version) => existsSync(join(sdk, "build-tools", version, d8Name)))
  .sort(compareVersions)
  .at(-1);
if (!buildTools) throw new Error(`No build-tools with d8 in ${join(sdk, "build-tools")}`);
const d8 = join(sdk, "build-tools", buildTools, d8Name);
// android.jar has no LambdaMetafactory.metafactory; build-tools ships stubs for javac, as the
// Android Gradle plugin uses them. d8 replaces the lambdas afterwards.
const lambdaStubs = join(sdk, "build-tools", buildTools, "core-lambda-stubs.jar");
if (!existsSync(lambdaStubs)) throw new Error(`Missing ${lambdaStubs}`);
const bootClassPath = [androidJar, lambdaStubs].join(delimiter);

const jdk = (tool) => {
  const exe = windows ? `${tool}.exe` : tool;
  return process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", exe) : exe;
};

function run(command, args) {
  if (windows && command.endsWith(".bat")) {
    // Batch files run through cmd.exe, which needs every argument quoted for it.
    const quote = (arg) => (/[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);
    execFileSync("cmd.exe", ["/d", "/s", "/c", `"${[command, ...args].map(quote).join(" ")}"`], {
      stdio: "inherit",
      windowsVerbatimArguments: true,
    });
  } else {
    execFileSync(command, args, { stdio: "inherit" });
  }
}

console.log(`Building the server with ${platform.name} and build-tools ${buildTools}`);
rmSync(buildDir, { recursive: true, force: true });
const classes = join(buildDir, "classes");
const testClasses = join(buildDir, "test-classes");

// 1. Protocol tests on the plain JVM.
run(jdk("javac"), ["--release", "8", "-encoding", "UTF-8", "-Xlint:all,-options", "-Werror", "-d", testClasses, ...plainSources, ...testSources]);
run(jdk("java"), ["-cp", testClasses, TEST_CLASS, vectors]);

// 2. The server against the Android platform. Java 8 syntax; d8 desugars it.
run(jdk("javac"), ["-source", "8", "-target", "8", "-bootclasspath", bootClassPath, "-encoding", "UTF-8", "-Xlint:all,-options", "-d", classes, ...mainSources]);
const classesJar = join(buildDir, "classes.jar");
run(jdk("jar"), ["--create", "--file", classesJar, "-C", classes, "."]);

// 3. DEX inside a jar, which app_process loads from CLASSPATH.
mkdirSync(dirname(output), { recursive: true });
rmSync(output, { force: true });
run(d8, ["--release", "--min-api", String(MIN_API), "--lib", androidJar, "--output", output, classesJar]);
console.log(`Built ${relative(root, output)} (${statSync(output).size} bytes)`);
