import { execSync } from 'child_process';
import * as path from 'path';

export const gradleWrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

export const gradleProjectPath = path.join(__dirname, '../../sample-projects/gradle-project');

export const gradleAvailable = (() => {
  try {
    execSync(`${gradleWrapper} --version`, {
      cwd: gradleProjectPath,
      timeout: 15000,
      stdio: 'ignore'
    });
    return true;
  } catch {
    return false;
  }
})();

export const describeGradle = gradleAvailable ? describe : describe.skip;
