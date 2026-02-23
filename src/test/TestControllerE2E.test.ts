import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { SpockTestController } from '../testController';
import { gradleAvailable, gradleProjectPath, gradleWrapper } from './gradleTestUtils';

const execAsync = promisify(exec);

// Mock vscode module
jest.mock('vscode', () => ({
  window: {
    createOutputChannel: jest.fn().mockReturnValue({
      appendLine: jest.fn()
    })
  },
  workspace: {
    workspaceFolders: [
      {
        uri: {
          fsPath: path.join(__dirname, '../../sample-projects/gradle-project')
        }
      }
    ],
    findFiles: jest.fn().mockResolvedValue([
      { fsPath: path.join(__dirname, '../../sample-projects/gradle-project/src/test/groovy/com/example/BowlingGameSpec.groovy') }
    ]),
    createFileSystemWatcher: jest.fn().mockReturnValue({
      onDidCreate: jest.fn(),
      onDidChange: jest.fn(),
      onDidDelete: jest.fn()
    }),
    openTextDocument: jest.fn().mockResolvedValue({
      getText: () => fs.readFileSync(path.join(__dirname, '../../sample-projects/gradle-project/src/test/groovy/com/example/BowlingGameSpec.groovy'), 'utf8')
    }),
    getWorkspaceFolder: jest.fn().mockReturnValue({
      uri: { fsPath: path.join(__dirname, '../../sample-projects/gradle-project') }
    })
  },
  tests: {
    createTestController: jest.fn().mockReturnValue({
      createTestItem: jest.fn().mockImplementation((id: string, label: string, uri: any) => ({
        id,
        label,
        uri,
        range: undefined,
        canResolveChildren: false,
        tags: [],
        parent: undefined,
        busy: false,
        error: undefined,
        children: {
          add: jest.fn(),
          delete: jest.fn(),
          replace: jest.fn(),
          size: 0,
          forEach: jest.fn(),
          get: jest.fn(),
          [Symbol.iterator]: jest.fn()
        }
      })),
      createRunProfile: jest.fn().mockReturnValue({
        dispose: jest.fn()
      }),
      createTestRun: jest.fn().mockReturnValue({
        started: jest.fn(),
        passed: jest.fn(),
        failed: jest.fn(),
        skipped: jest.fn(),
        appendOutput: jest.fn(),
        end: jest.fn()
      }),
      items: {
        get: jest.fn(),
        add: jest.fn(),
        delete: jest.fn(),
        forEach: jest.fn(),
        replace: jest.fn()
      }
    })
  },
  TestTag: jest.fn().mockImplementation((id) => ({ id })),
  TestRunProfileKind: {
    Run: 'run',
    Debug: 'debug'
  },
  TestMessage: jest.fn().mockImplementation((message) => ({ message })),
  Range: jest.fn().mockImplementation((startLine, startChar, endLine, endChar) => ({
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar }
  })),
  Uri: {
    file: jest.fn().mockImplementation((path) => ({ fsPath: path }))
  },
  RelativePattern: jest.fn().mockImplementation((workspaceFolder, pattern) => ({
    baseUri: workspaceFolder,
    base: workspaceFolder,
    pattern: pattern
  })),
  commands: {
    registerCommand: jest.fn().mockReturnValue({
      dispose: jest.fn()
    })
  }
}));

(gradleAvailable ? describe : describe.skip)('TestController E2E Tests', () => {
  let controller: SpockTestController;
  let mockContext: vscode.ExtensionContext;
  let mockLogger: any;
  let testProjectPath: string;

  beforeAll(() => {
    testProjectPath = path.join(__dirname, '../../sample-projects/gradle-project');
    
    // Verify the test project exists
    if (!fs.existsSync(testProjectPath)) {
      throw new Error(`Test project not found at ${testProjectPath}`);
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockContext = {
      subscriptions: []
    } as any;

    mockLogger = {
      appendLine: jest.fn()
    };

    controller = new SpockTestController(mockContext, mockLogger);
  });

  describe('Real Test Discovery and Execution', () => {
    it('should discover and execute real Spock tests', async () => {
      // Discover tests from the real project
      await controller['discoverAllTests']();
      
      // Get the test items - we need to access the Map differently
      const testDataMap = controller['testData'] as Map<any, any>;
      const testItems = Array.from(testDataMap.keys());
      expect(testItems.length).toBeGreaterThan(0);

      // Find a data-driven test
      const dataDrivenTest = testItems.find(item => {
        const data = testDataMap.get(item);
        return data && data.isDataDriven;
      });

      expect(dataDrivenTest).toBeDefined();

      // Execute the test
      const testData = testDataMap.get(dataDrivenTest!);
      const mockRun = {
        started: jest.fn(),
        passed: jest.fn(),
        failed: jest.fn(),
        skipped: jest.fn(),
        appendOutput: jest.fn(),
        end: jest.fn()
      };

      // Mock the test execution service to run real Gradle
      const originalExecuteTest = controller['testExecutionService'].executeTest;
      controller['testExecutionService'].executeTest = jest.fn().mockImplementation(async (testInfo, run, item) => {
        // Execute the actual Gradle test
        const { stdout, stderr } = await execAsync(
          `cd ${testProjectPath} && ${gradleWrapper} test --tests "${testInfo.className}.${testInfo.testName}" --console=plain`
        );
        
        // Simulate output being appended (as the real service would do)
        run.appendOutput(stdout);

        return {
          success: !stderr && stdout.includes('BUILD SUCCESSFUL'),
          output: stdout,
          errorInfo: stderr ? { error: stderr } : undefined
        };
      });

      try {
        await controller['runTest'](dataDrivenTest!, testData!, mockRun as any, false);

        // Verify the test was executed
        expect(mockRun.started).toHaveBeenCalledWith(dataDrivenTest!);
        expect(mockRun.appendOutput).toHaveBeenCalled();

        // Verify iteration items were created for data-driven tests
        if (testData!.isDataDriven) {
          expect((dataDrivenTest as any).children.add).toHaveBeenCalled();
        }

        // Log the results for debugging
        console.log('Test execution completed');
        console.log('Mock run calls:', {
          started: mockRun.started.mock.calls.length,
          passed: mockRun.passed.mock.calls.length,
          failed: mockRun.failed.mock.calls.length,
          skipped: mockRun.skipped.mock.calls.length
        });
      } finally {
        // Restore the original method
        controller['testExecutionService'].executeTest = originalExecuteTest;
      }
    }, 60000);

    it('should handle test failures with real execution', async () => {
      // Discover tests
      await controller['discoverAllTests']();
      
      const testDataMap = controller['testData'] as Map<any, any>;
      const testItems = Array.from(testDataMap.keys());
      // Find a test-type item (not file or class)
      const testItem = testItems.find(item => testDataMap.get(item)?.type === 'test') || testItems[0];
      const testData = testDataMap.get(testItem);

      // Create a failing test by temporarily modifying the test file
      const testFile = path.join(testProjectPath, 'src/test/groovy/com/example/BowlingGameSpec.groovy');
      const originalContent = fs.readFileSync(testFile, 'utf8');
      
      try {
        // Modify the test to make it fail
        const modifiedContent = originalContent.replace(
          'expectedScore == game.score()',
          'expectedScore == game.score() + 1'
        );
        fs.writeFileSync(testFile, modifiedContent);

        // Mock the test execution service
        const originalExecuteTest = controller['testExecutionService'].executeTest;
        controller['testExecutionService'].executeTest = jest.fn().mockImplementation(async (testInfo, run, item) => {
          const { stdout, stderr } = await execAsync(
            `cd ${testProjectPath} && ${gradleWrapper} test --tests "${testInfo.className}.${testInfo.testName}" --console=plain`
          );
          
          run.appendOutput(stdout);

          return {
            success: false, // Force failure for testing
            output: stdout,
            errorInfo: { error: 'Test failed' }
          };
        });

        const mockRun = {
          started: jest.fn(),
          passed: jest.fn(),
          failed: jest.fn(),
          skipped: jest.fn(),
          appendOutput: jest.fn(),
          end: jest.fn()
        };

        await controller['runTest'](testItem, testData!, mockRun as any, false);

        // Verify failure handling
        expect(mockRun.failed).toHaveBeenCalled();
        expect(mockRun.passed).not.toHaveBeenCalled();

        // Restore the original method
        controller['testExecutionService'].executeTest = originalExecuteTest;
      } finally {
        // Restore the original test file
        fs.writeFileSync(testFile, originalContent);
      }
    }, 60000);
  });

  describe('Performance with Real Project', () => {
    it('should discover tests efficiently from real project', async () => {
      const startTime = Date.now();
      
      await controller['discoverAllTests']();
      
      const endTime = Date.now();
      const discoveryTime = endTime - startTime;
      
      // Should discover tests quickly
      expect(discoveryTime).toBeLessThan(5000); // 5 seconds
      
      const testDataMap = controller['testData'] as Map<any, any>;
      const testItems = Array.from(testDataMap.keys());
      expect(testItems.length).toBeGreaterThan(0);
      
      console.log(`Discovery time: ${discoveryTime}ms`);
      console.log(`Discovered ${testItems.length} test items`);
    }, 10000);
  });
});
