package com.stormitron.stormcast.server;

/** Log lines on stdout and stderr. The app writes them to its log and shows them with errors. */
final class Ln {
    private Ln() {
    }

    static void i(String message) {
        System.out.println("INFO: " + message);
    }

    static void w(String message) {
        System.out.println("WARN: " + message);
    }

    static void e(String message) {
        System.err.println("ERROR: " + message);
    }
}
