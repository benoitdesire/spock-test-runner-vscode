@ECHO OFF
SETLOCAL

SET DIRNAME=%~dp0
IF "%DIRNAME%"=="" SET DIRNAME=.
SET APP_HOME=%DIRNAME%
FOR %%i IN ("%APP_HOME%") DO SET APP_HOME=%%~fi

SET CLASSPATH=%APP_HOME%\gradle\wrapper\gradle-wrapper.jar

IF DEFINED JAVA_HOME (
  SET JAVA_EXE=%JAVA_HOME%\bin\java.exe
  IF NOT EXIST "%JAVA_EXE%" (
    ECHO ERROR: JAVA_HOME is set to an invalid directory: %JAVA_HOME%
    ECHO Please set the JAVA_HOME variable to match your Java installation.
    EXIT /B 1
  )
) ELSE (
  SET JAVA_EXE=java.exe
  WHERE %JAVA_EXE% >NUL 2>&1
  IF %ERRORLEVEL% NEQ 0 (
    ECHO ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.
    ECHO Please set JAVA_HOME or add Java to PATH.
    EXIT /B 1
  )
)

"%JAVA_EXE%" "-Dorg.gradle.appname=gradlew" -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*
EXIT /B %ERRORLEVEL%