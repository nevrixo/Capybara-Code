# Capybara Code for VS Code

This extension is a client of the current-user Capybara daemon. It does not host a
second agent loop and never writes files or launches tools outside App Protocol.

Set capybara.daemonPath to the daemon socket or named pipe, open the Capybara
activity view, and connect. Session cursor ACKs are stored in workspace state so an
extension-host reload resumes from the last durable event. Unsaved selections are
bounded, digested, and checked by the same integration context policy before they
are attached to a turn.

Rich diff review opens VS Code's native diff editor only when the daemon advertises
diff.get and returns both revision-bound text versions. Unsupported methods are
reported rather than simulated.
