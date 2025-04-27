@echo off
cd /d E:\AI\Langchain\New Project

if exist .cosvika\Scripts\activate.bat (
    echo Activating virtual environment...
    call .cosvika\Scripts\activate.bat
) else (
    echo Virtual environment activation script not found!
    pause
    exit /b
)

timeout /t 1 >nul

python app.py
pause
