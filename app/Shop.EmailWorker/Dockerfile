# Requirement 4: the image of the email worker. The build context is the repository root (see docker-compose.yml),
# because the worker also needs the shared project app/Shop.Messaging.

# ---------- Stage 1: build ----------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Project files first, then restore: this layer is cached until a .csproj changes.
COPY app/Shop.Messaging/Shop.Messaging.csproj app/Shop.Messaging/
COPY app/Shop.EmailWorker/Shop.EmailWorker.csproj app/Shop.EmailWorker/
RUN dotnet restore app/Shop.EmailWorker/Shop.EmailWorker.csproj

COPY app/Shop.Messaging/ app/Shop.Messaging/
COPY app/Shop.EmailWorker/ app/Shop.EmailWorker/
RUN dotnet publish app/Shop.EmailWorker/Shop.EmailWorker.csproj -c Release -o /out --no-restore

# ---------- Stage 2: runtime ----------
# "runtime", not "aspnet": the worker is not a web server, it only needs .NET itself.
FROM mcr.microsoft.com/dotnet/runtime:10.0
WORKDIR /app
COPY --from=build /out .
USER $APP_UID
ENTRYPOINT ["dotnet", "Shop.EmailWorker.dll"]
