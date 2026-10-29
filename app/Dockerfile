# Builds the image of the main application in two stages.
# The build context is the repository root (see docker-compose.yml), so later
# the build can also read proto/ for the gRPC contract (Requirement 2).

# ---------- Stage 1: build (the SDK image has the compiler and every build tool) ----------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Copy only the project file and restore first. Docker caches this layer, so the
# NuGet packages are downloaded again only when the .csproj changes, not on every code change.
COPY app/Shop.Api/Shop.Api.csproj app/Shop.Api/
RUN dotnet restore app/Shop.Api/Shop.Api.csproj

# Now the rest of the code, then compile into ready-to-run files in /out.
COPY app/Shop.Api/ app/Shop.Api/
RUN dotnet publish app/Shop.Api/Shop.Api.csproj -c Release -o /out --no-restore

# ---------- Stage 2: runtime (only what is needed to run: much smaller, no compiler, no source code) ----------
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /out .

# Product images are saved here (a Docker volume in docker-compose.yml).
# The folder must belong to the non-root user, or saving an image fails.
RUN mkdir -p /app/uploads && chown $APP_UID /app/uploads

# Run as the image's built-in non-root user: if the app is ever hacked, the attacker is not root.
USER $APP_UID

# The aspnet image listens on port 8080 by default.
EXPOSE 8080
ENTRYPOINT ["dotnet", "Shop.Api.dll"]
