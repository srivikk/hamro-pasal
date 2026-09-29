import { configure } from '@testing-library/react-native';

// findBy*/waitFor default to 1 s, which a cold Jest transform cache can exceed on the first run.
configure({ asyncUtilTimeout: 5000 });
