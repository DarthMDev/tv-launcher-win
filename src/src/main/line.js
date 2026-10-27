// The line for the game. While Toon Valley is full, the login API answers
// Play with this player's place in line instead of a play token
// (login-api/main.py, take_turn). The launcher asks again when it says to,
// showing the place each time, until it hands over a play token; the game
// then starts by itself. The API keeps a place for a minute or so after
// the last ask, so a blip in the connection doesn't lose it.

// Codes (auth.js) worth asking again for while in line, and how many times
// in a row.
const RETRYABLE = new Set(['unavailable', 'server-error']);
const MAX_FAILURES = 4;
const RETRY_SECONDS = 5;

class Line {
  // onUpdate(update): the place in line ({ position, playing, capacity,
  // checkAgainIn }), { reconnecting: true } while the API isn't answering,
  // or null once waiting is over.
  constructor({ auth, onUpdate, timers = { setTimeout, clearTimeout } }) {
    this.auth = auth;
    this.onUpdate = onUpdate;
    this.timers = timers;
    this.left = false;
    this.wake = null;
    this.waited = false;
  }

  // A play token, or null if the player left the line. Throws what asking
  // for a play token throws (AuthError).
  async waitForTurn() {
    let failures = 0;
    try {
      for (;;) {
        let answer = null;
        try {
          answer = await this.auth.requestTurn();
          failures = 0;
        } catch (err) {
          // Only once in line: before that, it's Play's error as ever.
          if (!this.waited || !RETRYABLE.has(err.code) || ++failures >= MAX_FAILURES) throw err;
        }
        if (this.left) break;
        if (answer && answer.token) return answer.token;
        this.waited = true;
        this.onUpdate(answer ? answer.waiting : { reconnecting: true });
        await this.pause(answer ? answer.waiting.checkAgainIn : RETRY_SECONDS);
        if (this.left) break;
      }
      // (A play token that came as they left goes unused; it runs out.)
      await this.auth.leaveLine();
      return null;
    } finally {
      if (this.waited) this.onUpdate(null);
    }
  }

  leave() {
    this.left = true;
    if (this.wake) this.wake();
  }

  pause(seconds) {
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => {
        this.wake = null;
        resolve();
      }, seconds * 1000);
      this.wake = () => {
        this.timers.clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}

module.exports = { Line, RETRYABLE, MAX_FAILURES };
