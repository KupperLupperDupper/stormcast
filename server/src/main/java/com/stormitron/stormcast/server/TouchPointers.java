package com.stormitron.stormcast.server;

import java.util.ArrayList;
import java.util.List;

/**
 * The fingers that are down, in the order a MotionEvent lists them, and the MotionEvent action
 * for each change. Plain Java: tested on the JVM.
 */
final class TouchPointers {
    static final int MAX = 10;
    /** No event: the finger is unknown, or all slots are taken. */
    static final int NONE = -1;

    // MotionEvent's action values (public Android API), so this class runs without Android.
    static final int ACTION_DOWN = 0;
    static final int ACTION_UP = 1;
    static final int ACTION_MOVE = 2;
    static final int ACTION_CANCEL = 3;
    static final int ACTION_POINTER_DOWN = 5;
    static final int ACTION_POINTER_UP = 6;
    private static final int POINTER_INDEX_SHIFT = 8;

    private static final class Finger {
        final long id;
        /** The small id Android sees, free for reuse once the finger is up. */
        final int localId;
        float x;
        float y;
        float pressure;
        boolean lifted;

        Finger(long id, int localId) {
            this.id = id;
            this.localId = localId;
        }
    }

    private final List<Finger> fingers = new ArrayList<>();

    int size() {
        return fingers.size();
    }

    int localId(int index) {
        return fingers.get(index).localId;
    }

    float x(int index) {
        return fingers.get(index).x;
    }

    float y(int index) {
        return fingers.get(index).y;
    }

    float pressure(int index) {
        return fingers.get(index).pressure;
    }

    boolean isDown(long id) {
        return indexOf(id) >= 0;
    }

    /** A finger goes down. NONE when it is down already or all slots are taken. */
    int down(long id, float x, float y, float pressure) {
        if (isDown(id) || fingers.size() == MAX) {
            return NONE;
        }
        Finger finger = new Finger(id, freeLocalId());
        fingers.add(finger);
        place(finger, x, y, pressure);
        int index = fingers.size() - 1;
        return index == 0 ? ACTION_DOWN : ACTION_POINTER_DOWN | index << POINTER_INDEX_SHIFT;
    }

    int move(long id, float x, float y, float pressure) {
        int index = indexOf(id);
        if (index < 0) {
            return NONE;
        }
        place(fingers.get(index), x, y, pressure);
        return ACTION_MOVE;
    }

    /** A finger goes up. It stays in the list for its event; call removeLifted() after that. */
    int up(long id, float x, float y, float pressure) {
        int index = indexOf(id);
        if (index < 0) {
            return NONE;
        }
        Finger finger = fingers.get(index);
        place(finger, x, y, pressure);
        finger.lifted = true;
        return fingers.size() == 1 ? ACTION_UP : ACTION_POINTER_UP | index << POINTER_INDEX_SHIFT;
    }

    /** Ends the whole touch. The fingers stay in the list for the event; call removeLifted() after that. */
    int cancel() {
        if (fingers.isEmpty()) {
            return NONE;
        }
        for (Finger finger : fingers) {
            finger.lifted = true;
        }
        return ACTION_CANCEL;
    }

    void removeLifted() {
        for (int i = fingers.size() - 1; i >= 0; i--) {
            if (fingers.get(i).lifted) {
                fingers.remove(i);
            }
        }
    }

    private int indexOf(long id) {
        for (int i = 0; i < fingers.size(); i++) {
            if (fingers.get(i).id == id) {
                return i;
            }
        }
        return -1;
    }

    private int freeLocalId() {
        for (int localId = 0; ; localId++) {
            boolean used = false;
            for (Finger finger : fingers) {
                used |= finger.localId == localId;
            }
            if (!used) {
                return localId;
            }
        }
    }

    private static void place(Finger finger, float x, float y, float pressure) {
        finger.x = x;
        finger.y = y;
        finger.pressure = pressure;
    }
}
