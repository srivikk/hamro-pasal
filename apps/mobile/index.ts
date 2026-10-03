// App entry. The push task is registered before the router loads: for a data-only push the OS
// starts the app headless and evaluates only this module's imports, never the UI.
import './src/features/notifications/register-order-push-task';
import 'expo-router/entry';
