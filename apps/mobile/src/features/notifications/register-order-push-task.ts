import { registerOrderPushTask } from './order-push-task';

// Side-effect module, imported first by the app entry (index.ts): TaskManager tasks must be
// defined in the global scope of the bundle, before any React component mounts.
registerOrderPushTask();
